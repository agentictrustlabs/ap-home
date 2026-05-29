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
  return [JSON.parse(raw) as EvidenceLink];
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
 *  the directory's on-chain confirmCandidates (which would drop it). spec 227 §5. */
export async function readOidcFacet(kv: KvLike, iss: string, sub: string): Promise<CanonicalAgentId | null> {
  const raw = await kv.get(oidcKey(iss, sub));
  if (!raw) return null;
  return (JSON.parse(raw) as EvidenceLink).agent;
}

/** Record an (iss,sub)->agent login facet (login-grade). Broker-authorized only (P0-C). */
export async function recordOidcFacet(
  kv: KvLike,
  iss: string,
  sub: string,
  agent: CanonicalAgentId,
): Promise<void> {
  const link: EvidenceLink = { agent, assurance: 'asserted', ref: 'kv-oidc' };
  await kv.put(oidcKey(iss, sub), JSON.stringify(link));
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

/** Record a credential->agent link the indexer PROPOSES (the on-chain port confirms). */
export async function recordCredentialFacet(
  kv: KvLike,
  p: CredentialPrincipal,
  agent: CanonicalAgentId,
): Promise<void> {
  const link: EvidenceLink = { agent, assurance: 'asserted', ref: 'kv-cred' };
  await kv.put(credKey(p.kind, p.id), JSON.stringify(link));
}
