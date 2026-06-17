// demo-mcp's encrypted Vault adapter (spec 277 Phase 2; per-person keying spec 278 P4).
//
// Implements the `@agenticprimitives/vault` `Vault` interface with envelope
// encryption: payloads are AES-256-GCM sealed (sealEnvelope) under a per-object
// DEK wrapped by the OWNER's KEK (the injected `wrapper`), and stored in the D1
// `vault_objects` table (base64 ciphertext + wrapped DEK + crypto metadata).
// No plaintext PII at rest. The PII/org seeds are materialized + sealed on
// first read (the legacy plaintext person_pii/org_sensitive/vault_records tables
// were dropped in migration 0006). The tool handlers call vault.read/write only.
//
// Crypto backend: the wrapper is built per-person by `resolvePersonVault`
// (src/vault-key.ts → `selectVaultKeyProvider`), which resolves the owner's
// `VaultKeyBinding` and wields that person's GCP Cloud KMS KEK. There is NO
// global key (VKB-D1) — no binding ⇒ fail-closed (`vault_key_unauthorized`).
// This adapter never selects a backend; it just seals/opens under the wrapper
// it is handed (see the per-person construction note at `createDemoVault`).

import type { Vault, VaultObject, VaultReadRequest, VaultWriteRequest, VaultRef, VaultClassification, DekWrapper } from '@agenticprimitives/vault';
import { sealEnvelope, openEnvelope, projectFields } from '@agenticprimitives/vault';
import {
  type Profile,
  type PersonPii,
  type OrgSensitive,
  buildSeedProfile,
  buildSeedPii,
  buildSeedOrgSensitive,
  getVaultObjectRow,
  putVaultObjectRow,
  tombstoneVaultObjectRow,
  listVaultObjectRows,
} from './db.js';

export const RESOURCE_PROFILE = 'profile';
export const RESOURCE_PERSON_PII = 'person-pii';
export const RESOURCE_ORG_SENSITIVE = 'org-sensitive';
/** Generic per-agent vault records are addressed as `vault:<recordType>`. */
export const VAULT_RECORD_PREFIX = 'vault:';

const CLASSIFICATION: Record<string, VaultClassification> = {
  [RESOURCE_PROFILE]: 'pii.low',
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

// spec 278 P4 — there is NO `demoVault(env)` global anymore. A single global
// DEK-wrapping key that decrypts every owner is exactly what VKB-D1 forbids. The
// Vault is built per-person from that person's KEK via `resolvePersonVault`
// (src/vault-key.ts), which calls `createDemoVault(db, perPersonWrapper)` below.

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

      // Absent → seed-on-read for the typed profile/PII/org resources (sealed fresh).
      let seed: Profile | PersonPii | OrgSensitive | null = null;
      if (req.resource === RESOURCE_PROFILE) seed = buildSeedProfile(owner);
      else if (req.resource === RESOURCE_PERSON_PII) seed = buildSeedPii(owner);
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
