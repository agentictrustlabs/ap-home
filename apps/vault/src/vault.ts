// demo-mcp's encrypted Vault adapter (spec 277 Phase 2).
//
// Implements the `@agenticprimitives/vault` `Vault` interface with envelope
// encryption: payloads are AES-256-GCM sealed (sealEnvelope) under a per-object
// DEK wrapped by key-custody's LocalAesProvider, and stored in the D1
// `vault_objects` table (base64 ciphertext + wrapped DEK + crypto metadata).
// No plaintext PII at rest. The PII/org seeds are materialized + sealed on
// first read (the legacy plaintext person_pii/org_sensitive/vault_records tables
// were dropped in migration 0006). The tool handlers call vault.read/write only.
//
// Crypto backend (testnet-demo grade): LocalAesProvider keyed by VAULT_MASTER_KEY.
// On Workers `NODE_ENV` is unset, so LocalAesProvider fails closed unless the
// A2A_ALLOW_LOCAL_ENVELOPE_KEY opt-in is set; wrangler vars live on the binding
// env, not process.env (where the guard reads), so we bridge it. A managed KMS
// backend MUST replace LocalAes before any real-value data.

import type { Vault, VaultObject, VaultReadRequest, VaultWriteRequest, VaultRef, VaultClassification, DekWrapper } from '@agenticprimitives/vault';
import { sealEnvelope, openEnvelope, projectFields } from '@agenticprimitives/vault';
import { LocalAesProvider } from '@agenticprimitives/key-custody';
import {
  type PersonPii,
  type OrgSensitive,
  buildSeedPii,
  buildSeedOrgSensitive,
  getVaultObjectRow,
  putVaultObjectRow,
  tombstoneVaultObjectRow,
  listVaultObjectRows,
} from './db.js';

export const RESOURCE_PERSON_PII = 'person-pii';
export const RESOURCE_ORG_SENSITIVE = 'org-sensitive';
/** Generic per-agent vault records are addressed as `vault:<recordType>`. */
export const VAULT_RECORD_PREFIX = 'vault:';

const CLASSIFICATION: Record<string, VaultClassification> = {
  [RESOURCE_PERSON_PII]: 'pii.sensitive',
  [RESOURCE_ORG_SENSITIVE]: 'regulated.high',
};
const DEFAULT_CLASSIFICATION: VaultClassification = 'internal';

export function classificationFor(resource: string): VaultClassification {
  return CLASSIFICATION[resource] ?? DEFAULT_CLASSIFICATION;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface VaultEnv {
  DB: D1Database;
  VAULT_MASTER_KEY?: string;
  A2A_ALLOW_LOCAL_ENVELOPE_KEY?: string;
}

/** Build the encrypted demo-mcp Vault from the Worker env. */
export function demoVault(env: VaultEnv): Vault {
  // Bridge the binding opt-in into process.env, where LocalAesProvider's
  // production guard reads it (Workers don't expose wrangler vars on process.env).
  if (env.A2A_ALLOW_LOCAL_ENVELOPE_KEY === 'true' && typeof process !== 'undefined' && process.env) {
    process.env.A2A_ALLOW_LOCAL_ENVELOPE_KEY = 'true';
  }
  if (!env.VAULT_MASTER_KEY) {
    throw new Error('demoVault: VAULT_MASTER_KEY is required to envelope-encrypt the vault (spec 277 Phase 2).');
  }
  const wrapper: DekWrapper = new LocalAesProvider({ sessionSecretHex: env.VAULT_MASTER_KEY });
  return createDemoVault(env.DB, wrapper);
}

/** The encrypted adapter (wrapper injected — testable + KMS-swappable). */
export function createDemoVault(db: D1Database, wrapper: DekWrapper): Vault {
  async function seal(owner: string, resource: string, classification: VaultClassification, data: unknown): Promise<void> {
    const sealed = await sealEnvelope({ owner, resource, classification, data, wrapper });
    await putVaultObjectRow(db, {
      owner_address: owner,
      resource,
      classification,
      ciphertext_b64: b64encode(sealed.ciphertext),
      wrapped_dek_b64: b64encode(sealed.wrappedDek),
      crypto_meta: JSON.stringify(sealed.envelope.crypto),
    });
  }

  return {
    async read<T = unknown>(req: VaultReadRequest): Promise<VaultObject<T> | null> {
      const owner = req.owner;
      const row = await getVaultObjectRow(db, owner, req.resource);
      if (row) {
        const data = await openEnvelope<T>({
          envelope: {
            owner: row.owner_address,
            resource: row.resource,
            classification: row.classification as VaultClassification,
            crypto: JSON.parse(row.crypto_meta),
          },
          ciphertext: b64decode(row.ciphertext_b64),
          wrappedDek: b64decode(row.wrapped_dek_b64),
          wrapper,
        });
        return {
          owner: row.owner_address,
          resource: row.resource,
          classification: row.classification as VaultClassification,
          data: projectFields(data, req.fields) as T,
          updatedAt: row.updated_at,
        };
      }

      // Absent → seed-on-read for the typed PII/org resources (sealed fresh).
      let seed: PersonPii | OrgSensitive | null = null;
      if (req.resource === RESOURCE_PERSON_PII) seed = buildSeedPii(owner);
      else if (req.resource === RESOURCE_ORG_SENSITIVE) seed = buildSeedOrgSensitive(owner);
      if (seed === null) return null; // generic vault:<type> has no seed

      const classification = classificationFor(req.resource);
      await seal(owner, req.resource, classification, seed);
      return {
        owner: owner.toLowerCase(),
        resource: req.resource,
        classification,
        data: projectFields(seed, req.fields) as T,
        updatedAt: new Date().toISOString(),
      };
    },

    async write<T = unknown>(req: VaultWriteRequest<T>): Promise<void> {
      if (req.data === null) {
        await tombstoneVaultObjectRow(db, req.owner, req.resource);
        return;
      }
      await seal(req.owner, req.resource, req.classification ?? classificationFor(req.resource), req.data);
    },

    async list(owner: string): Promise<VaultRef[]> {
      const rows = await listVaultObjectRows(db, owner);
      return rows.map((r) => ({
        resource: r.resource,
        classification: r.classification as VaultClassification,
        updatedAt: r.updated_at,
      }));
    },
  };
}
