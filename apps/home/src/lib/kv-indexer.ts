// A KV-backed IndexerPort (spec 227 §5): the persistent login-facet index that
// PROPOSES (iss,sub)->agent + credential->agent links. The on-chain port CONFIRMS
// (audit P1-3): an OIDC link stays `asserted`/login-grade (never on-chain-confirmed,
// P0-B); a custody link is confirmed by `isCustodian`. Keys are `facet:`-prefixed.
//
// Writes (enrollment) are performed by the broker ONLY after a custody-grade
// AgentSession of THAT agent authorizes them (spec 227 P0-C) — this module is the
// storage, not the authorization gate.

import type { IndexerPort, EvidenceLink } from '@agenticprimitives/identity-directory';
import type { CanonicalAgentId, CredentialPrincipal } from '@agenticprimitives/types';

/** Minimal KV surface (satisfied by a Cloudflare KVNamespace). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

const oidcKey = (iss: string, sub: string): string => `facet:oidc:${iss}#${sub}`;
const credKey = (kind: string, id: string): string => `facet:cred:${kind}:${id}`;
const rotationKey = (iss: string, sub: string): string => `rotation:${iss}#${sub}`;

async function readLinks(kv: KvLike, key: string): Promise<EvidenceLink[]> {
  const raw = await kv.get(key);
  if (!raw) return []; // empty is terminal (ADR-0013) — no fallback
  // SEC-009: facets are stored as an APPEND-ONLY array so historic enrollments are
  // preserved + auditable. Legacy single-object entries are read as a one-item list.
  try {
    const parsed = JSON.parse(raw) as EvidenceLink | EvidenceLink[];
    if (Array.isArray(parsed)) return parsed;
    return parsed && typeof parsed === 'object' && 'agent' in parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

/** SEC-009: append-only facet writer. De-dupes by (agent, assurance, ref) — a second
 *  enrollment with identical evidence is idempotent; a new triple appends. Replaces
 *  the prior `kv.put` overwrite (which silently bridged agents on credKey collision). */
async function appendLink(kv: KvLike, key: string, link: EvidenceLink): Promise<void> {
  const existing = await readLinks(kv, key);
  if (existing.some((e) => e.agent === link.agent && e.assurance === link.assurance && e.ref === link.ref)) {
    return; // already present — no-op
  }
  await kv.put(key, JSON.stringify([...existing, link]));
}

/** A persistent IndexerPort over KV. Proposes only; the directory confirms on-chain. */
export function createKvIndexer(kv: KvLike): IndexerPort {
  return {
    agentsByCredential: (p: CredentialPrincipal) => readLinks(kv, credKey(p.kind, p.id)),
    agentsByOidcSubject: (iss: string, sub: string) => readLinks(kv, oidcKey(iss, sub)),
  };
}

/** Read the (iss,sub)->agent OIDC facet directly (login-grade resolution). OIDC has
 *  no on-chain presence, so it resolves from the indexer at `asserted`, NOT through
 *  the directory's on-chain confirmCandidates (which would drop it). spec 227 §5.
 *  SEC-009: returns the FIRST entry from the append-only list — preserves stable
 *  resolution for the demo while keeping the historical chain auditable. Multiple
 *  agents on the same (iss,sub) would be a misconfiguration; the directory's
 *  on-chain confirm step is where that would surface in production. */
export async function readOidcFacet(kv: KvLike, iss: string, sub: string): Promise<CanonicalAgentId | null> {
  const links = await readLinks(kv, oidcKey(iss, sub));
  return links[0]?.agent ?? null;
}

/** Record an (iss,sub)->agent login facet (login-grade). Broker-authorized only (P0-C).
 *  SEC-009: append-only — overwrite has been eliminated. */
export async function recordOidcFacet(
  kv: KvLike,
  iss: string,
  sub: string,
  agent: CanonicalAgentId,
): Promise<void> {
  await appendLink(kv, oidcKey(iss, sub), { agent, assurance: 'asserted', ref: 'kv-oidc' });
}

// ── Email login facet (login-grade, asserted — structurally identical to the OIDC facet) ──────────
// Email proves inbox control, never on-chain custody. The KEY is SHA-256(normalized email) — the raw
// address is NEVER stored (privacy; the facet is a login pointer, not PII). `enroll.ts` rejects a
// `kind:'email'` facet the same way it rejects `oidc` (can't self-verify on-chain).
async function emailHash(email: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.toLowerCase().trim()));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const emailFacetKey = (hash: string): string => `facet:email:${hash}`;

/** SHA-256(normalized email) — the facet key + the CredentialPrincipal.id. Exported so the verify
 *  route + invite redemption use the identical hash (never the raw address). */
export { emailHash };

export async function readEmailFacet(kv: KvLike, email: string): Promise<CanonicalAgentId | null> {
  const links = await readLinks(kv, emailFacetKey(await emailHash(email)));
  return links[0]?.agent ?? null;
}

/** Record an email->agent login facet (login-grade). Only written when a custody-grade session of the
 *  TARGET agent authorizes it (same security model as the Google link path). SEC-009: append-only. */
export async function recordEmailFacet(kv: KvLike, email: string, agent: CanonicalAgentId): Promise<void> {
  await appendLink(kv, emailFacetKey(await emailHash(email)), { agent, assurance: 'asserted', ref: 'kv-email' });
}

/** Hash-keyed variants for the invite magic-link path — the redeeming server holds only the invited
 *  email's SHA-256 (blast-zone: the raw address was never stored), so it reads/writes the facet by hash.
 *  Identical to `readEmailFacet`/`recordEmailFacet` otherwise (the hash IS the facet key). */
export async function readEmailFacetByHash(kv: KvLike, hash: string): Promise<CanonicalAgentId | null> {
  const links = await readLinks(kv, emailFacetKey(hash));
  return links[0]?.agent ?? null;
}
export async function recordEmailFacetByHash(kv: KvLike, hash: string, agent: CanonicalAgentId): Promise<void> {
  await appendLink(kv, emailFacetKey(hash), { agent, assurance: 'asserted', ref: 'kv-email-invite' });
}

// ── Phone (SMS) login facet (login-grade, asserted — structurally identical to the email facet) ──────
// Phone proves telecom-address control (verified via Twilio Verify, spec 320), never on-chain custody.
// The KEY is SHA-256(E.164) — the raw number is NEVER stored (privacy). `enroll.ts` rejects a
// `kind:'phone'` facet the same way it rejects `email`/`oidc`. NOTE (spec 320 §hardening): the phone-number
// space is enumerable, so a plaintext SHA-256 is reversible by brute force in a KV-leak scenario; a keyed
// HMAC blind index (`HMAC(PHONE_LOOKUP_SECRET, e164)`) is the documented hardening — deferred here to keep
// the derivation secret-free (a rotating lookup secret would orphan every phone-bootstrapped home).
async function phoneHash(phoneE164: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phoneE164.trim()));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const phoneFacetKey = (hash: string): string => `facet:phone:${hash}`;

/** SHA-256(E.164 phone) — the facet key + the CredentialPrincipal.id. Exported so the verify route uses
 *  the identical hash (never the raw number). The caller normalizes to E.164 BEFORE hashing. */
export { phoneHash };

export async function readPhoneFacet(kv: KvLike, phoneE164: string): Promise<CanonicalAgentId | null> {
  const links = await readLinks(kv, phoneFacetKey(await phoneHash(phoneE164)));
  return links[0]?.agent ?? null;
}

/** Record a phone->agent login facet (login-grade). SEC-009: append-only. */
export async function recordPhoneFacet(kv: KvLike, phoneE164: string, agent: CanonicalAgentId): Promise<void> {
  await appendLink(kv, phoneFacetKey(await phoneHash(phoneE164)), { agent, assurance: 'asserted', ref: 'kv-phone' });
}

/** Read the per-(iss,sub) Google × KMS custody rotation (spec 235 §5b). Default 0 — the first
 *  home. The custody gate derives `C_sub(iss,sub,rotation)`, so the broker + demo-a2a must agree. */
export async function readRotation(kv: KvLike, iss: string, sub: string): Promise<number> {
  const raw = await kv.get(rotationKey(iss, sub));
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Bump the rotation → the next Google sign-in derives a FRESH home ("use Google for a new home").
 *  Returns the new rotation. The old home is left behind (still server-custodied), per spec 235 §5b. */
export async function bumpRotation(kv: KvLike, iss: string, sub: string): Promise<number> {
  const next = (await readRotation(kv, iss, sub)) + 1;
  await kv.put(rotationKey(iss, sub), String(next));
  return next;
}

/** Record a credential->agent link the indexer PROPOSES (the on-chain port confirms).
 *  SEC-009: append-only — overwrite has been eliminated. Idempotent for duplicate
 *  enrollments; multiple distinct agents on the same credential surface naturally to
 *  the directory's confirm step (no silent agent-bridging on credKey collision). */
export async function recordCredentialFacet(
  kv: KvLike,
  p: CredentialPrincipal,
  agent: CanonicalAgentId,
): Promise<void> {
  await appendLink(kv, credKey(p.kind, p.id), { agent, assurance: 'asserted', ref: 'kv-cred' });
}

/** Standalone read of a credential->agent facet. Needed for passkey login to resolve a passkey that is a
 *  SECONDARY custodian of a KMS/social home (phone/email/google) — whose SA is NOT derived from the passkey,
 *  so derivation alone lands on the wrong (passkey-direct) address. Returns the first linked agent or null. */
export async function readCredentialFacet(kv: KvLike, kind: string, id: string): Promise<CanonicalAgentId | null> {
  const links = await readLinks(kv, credKey(kind, id));
  return links[0]?.agent ?? null;
}
