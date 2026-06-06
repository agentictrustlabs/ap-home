// Federated user-data token custody (spec 265). Per-person YouVersion OAuth tokens, ENVELOPE-encrypted
// at rest (a fresh AES-GCM data key per record, itself wrapped by the KMS backend) and stored in the
// FED_TOKENS KV keyed by the person SA. Read ONLY here, server-side — the plaintext token is NEVER
// returned to a relying app or grantee; the youversion read-proxy uses it to fetch data and returns only
// the data. AAD binds each record to its (sa, provider) so a ciphertext can't be moved to another person.
import { buildKeyProvider, type A2AKeyProvider, type KmsBackend } from '@agenticprimitives/key-custody';
import type { Address } from '@agenticprimitives/types';

export interface FederatedTokens {
  access: string;
  refresh: string | null;
}

interface StoredFedToken {
  provider: 'youversion';
  edk: string;       // base64 encrypted data key (KMS-wrapped)
  keyId: string;
  keyVersion: string;
  iv: string;        // base64 AES-GCM IV
  ct: string;        // base64 AES-GCM ciphertext of JSON(FederatedTokens)
  exp: number;       // access-token expiry (unix sec) — non-sensitive metadata, stored in clear
  scope: string | null;
  appKey: string;    // the YouVersion App Key (public client_id) — needed for refresh + the X-YVP-App-Key header
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fresh = (u: Uint8Array): Uint8Array<ArrayBuffer> => { const o = new Uint8Array(u.byteLength); o.set(u); return o; };

interface FedEnv { FED_TOKENS?: KVNamespace }

/** The envelope-encryption provider, selected by env exactly like `sessionManagerFor` — GCP KMS in
 *  production, local-aes in dev (which fail-closes under NODE_ENV=production per its own guard). */
function envelopeProvider(env: { GCP_KMS_ENCRYPT_KEY_NAME?: string; GCP_SERVICE_ACCOUNT_JSON?: string }): A2AKeyProvider {
  const backend = ((process.env.A2A_KMS_BACKEND as KmsBackend | undefined) || 'local-aes');
  return backend === 'gcp-kms' && env.GCP_KMS_ENCRYPT_KEY_NAME && env.GCP_SERVICE_ACCOUNT_JSON
    ? buildKeyProvider({ backend: 'gcp-kms', config: { cryptoKeyName: env.GCP_KMS_ENCRYPT_KEY_NAME, serviceAccountJson: env.GCP_SERVICE_ACCOUNT_JSON } })
    : buildKeyProvider({ backend: 'local-aes' });
}

function aad(sa: Address): Record<string, string> {
  return { purpose: 'fed-token', provider: 'youversion', sa: sa.toLowerCase() };
}

const key = (sa: Address): string => `youversion:${sa.toLowerCase()}`;

/** Envelope-encrypt + store a person's YouVersion tokens, keyed by their SA. `expiresInSec` from the
 *  provider's `expires_in`; we stamp an absolute expiry. */
export async function storeFederatedToken(
  env: FedEnv & { GCP_KMS_ENCRYPT_KEY_NAME?: string; GCP_SERVICE_ACCOUNT_JSON?: string },
  sa: Address,
  tokens: FederatedTokens,
  expiresInSec: number | null,
  scope: string | null,
  appKey: string,
): Promise<void> {
  if (!env.FED_TOKENS) throw new Error('FED_TOKENS not configured');
  const provider = envelopeProvider(env);
  const aadContext = aad(sa);
  const { plaintextDataKey, encryptedDataKey, keyId, keyVersion } = await provider.generateSessionDataKey({ aadContext });
  const cryptoKey = await crypto.subtle.importKey('raw', fresh(plaintextDataKey), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(tokens))));
  const exp = Math.floor(Date.now() / 1000) + (expiresInSec && expiresInSec > 0 ? expiresInSec : 3000);
  const rec: StoredFedToken = { provider: 'youversion', edk: b64(encryptedDataKey), keyId, keyVersion, iv: b64(iv), ct: b64(ct), exp, scope, appKey };
  await env.FED_TOKENS.put(key(sa), JSON.stringify(rec));
}

/** Load + decrypt a person's tokens, or null when none stored. `exp` is the access-token expiry so the
 *  caller can decide to refresh. */
export async function loadFederatedToken(
  env: FedEnv & { GCP_KMS_ENCRYPT_KEY_NAME?: string; GCP_SERVICE_ACCOUNT_JSON?: string },
  sa: Address,
): Promise<{ tokens: FederatedTokens; exp: number; scope: string | null; appKey: string } | null> {
  if (!env.FED_TOKENS) return null;
  const raw = await env.FED_TOKENS.get(key(sa));
  if (!raw) return null;
  const rec = JSON.parse(raw) as StoredFedToken;
  const provider = envelopeProvider(env);
  const plaintextDataKey = await provider.decryptSessionDataKey({
    encryptedDataKey: unb64(rec.edk), aadContext: aad(sa), keyId: rec.keyId, keyVersion: rec.keyVersion,
  });
  const cryptoKey = await crypto.subtle.importKey('raw', fresh(plaintextDataKey), { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fresh(unb64(rec.iv)) }, cryptoKey, fresh(unb64(rec.ct)));
  const tokens = JSON.parse(new TextDecoder().decode(pt)) as FederatedTokens;
  return { tokens, exp: rec.exp, scope: rec.scope, appKey: rec.appKey };
}

/** Delete a person's stored tokens (YouVersion unlink). */
export async function deleteFederatedToken(env: FedEnv, sa: Address): Promise<void> {
  await env.FED_TOKENS?.delete(key(sa));
}

// ─── VaultGrant data-scope records (spec 265 W3) ──────────────────────────────
// Which YouVersion data types a person has granted an app to read. Stored in the SAME KV with a `grant:`
// prefix, keyed by (person SA, app delegate). Written under the person's authority (Connect, bridge);
// read by the youversion read routes to gate each data type per app.

/** The grantable YouVersion data types (our internal scope vocabulary — distinct from the OAuth scope
 *  strings like `read_highlights`). YouVersion's Platform API exposes exactly ONE user-data resource:
 *  highlights (read per Bible chapter). There is NO notes / bookmarks / saved-verses API — the SDK
 *  "notes" are scripture footnotes, not personal notes — so we do not invent grant types with no backing
 *  read endpoint or OAuth scope. */
export type YouVersionDataScope = 'highlights';
export const YOUVERSION_DATA_SCOPES: YouVersionDataScope[] = ['highlights'];

const grantKey = (person: Address, app: Address): string => `grant:${person.toLowerCase()}:${app.toLowerCase()}`;

export async function setYouVersionGrant(env: FedEnv, person: Address, app: Address, scopes: YouVersionDataScope[]): Promise<void> {
  if (!env.FED_TOKENS) throw new Error('FED_TOKENS not configured');
  const clean = scopes.filter((s) => YOUVERSION_DATA_SCOPES.includes(s));
  if (clean.length === 0) { await env.FED_TOKENS.delete(grantKey(person, app)); return; } // empty = revoke
  await env.FED_TOKENS.put(grantKey(person, app), JSON.stringify({ scopes: clean }));
}

export async function getYouVersionGrant(env: FedEnv, person: Address, app: Address): Promise<YouVersionDataScope[]> {
  if (!env.FED_TOKENS) return [];
  const raw = await env.FED_TOKENS.get(grantKey(person, app));
  if (!raw) return [];
  try { return (JSON.parse(raw) as { scopes?: YouVersionDataScope[] }).scopes ?? []; } catch { return []; }
}
