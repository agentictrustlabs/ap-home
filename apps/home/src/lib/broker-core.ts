// Shared broker core — the directory wiring + issuance/verification logic, with
// the signing key INJECTED. Used by both the in-browser demo broker
// (src/broker.ts, key generated in-page) and the server-side Pages Function
// broker (functions/*, key from an env secret). Pure Web Crypto — browser- AND
// Workers-safe (no node:url; ontology's main entry is browser-safe).

import {
  issueForResolution,
  verifyAgentSession,
  importJwks,
  requiresStepUp,
  type BrokerSigner,
  type BrokerAlg,
  type IssueOutcome,
  type VerifyResult,
} from '@agenticprimitives/connect';
import { createDirectory, type IdentityDirectory } from '@agenticprimitives/identity-directory';
import {
  makeNamingPort,
  makeOnChainReadPort,
  createInMemoryIndexer,
  toCanonicalAgentId,
  type IndexerEntry,
} from '@agenticprimitives/identity-directory-adapters';
import type { Address, CanonicalAgentId, CredentialPrincipal, AgentSession } from '@agenticprimitives/types';

export const CHAIN = 8453;
const SESSION_TTL_SECONDS = 600;

// The token `iss` is the ACTUAL Connect origin (derived from the serving origin),
// not a hardcoded constant — so it is correct in every environment (local
// :5373/:8788, a *.pages.dev deploy, a custom domain). Server functions pass the
// request origin; the browser passes `window.location.origin`. Server + client,
// served from the same origin, agree by construction.

const ALICE_ADDR = '0x1111111111111111111111111111111111111111' as Address;
const BOB_ADDR = '0x2222222222222222222222222222222222222222' as Address;
export const ALICE: CanonicalAgentId = toCanonicalAgentId(CHAIN, ALICE_ADDR);
export const BOB: CanonicalAgentId = toCanonicalAgentId(CHAIN, BOB_ADDR);

// passkey = custody-grade; GitHub OIDC = login-grade (ADR-0017).
export const ALICE_PASSKEY: CredentialPrincipal = { kind: 'passkey', id: 'alice-passkey-01', assurance: 'onchain-confirmed', role: 'custody-grade' };
export const ALICE_OIDC: CredentialPrincipal = { kind: 'oidc', id: 'https://github.com#1001', assurance: 'asserted', role: 'login-grade' };
export const BOB_PASSKEY: CredentialPrincipal = { kind: 'passkey', id: 'bob-passkey-01', assurance: 'onchain-confirmed', role: 'custody-grade' };

function memberKey(agent: CanonicalAgentId, p: CredentialPrincipal): string {
  return `${agent}|${p.kind}|${p.id}`;
}

// The on-chain CURRENT custody set (demo: a Set; production: readContract).
const onChainMembership = new Set<string>([
  memberKey(ALICE, ALICE_PASSKEY),
  memberKey(ALICE, ALICE_OIDC),
  memberKey(BOB, BOB_PASSKEY),
]);

const indexEntries: IndexerEntry[] = [
  { agent: ALICE, principalKind: 'passkey', principalId: ALICE_PASSKEY.id, assurance: 'asserted', ref: 'demo-index' },
  { agent: ALICE, principalKind: 'oidc', principalId: ALICE_OIDC.id, assurance: 'asserted', ref: 'demo-index' },
  { agent: BOB, principalKind: 'passkey', principalId: BOB_PASSKEY.id, assurance: 'asserted', ref: 'demo-index' },
];

const NAMES: Record<string, Address> = { 'alice.agent': ALICE_ADDR, 'bob.agent': BOB_ADDR };
const reverseNames: Record<string, string> = {
  [ALICE_ADDR.toLowerCase()]: 'alice.agent',
  [BOB_ADDR.toLowerCase()]: 'bob.agent',
};

const GOOGLE_ISS = 'https://accounts.google.com';
function isGoogleOidc(p: CredentialPrincipal): boolean {
  return p.kind === 'oidc' && p.id.startsWith(`${GOOGLE_ISS}#`);
}

/**
 * Build the demo directory (mock ports + seeds). Shared by both broker variants.
 *
 * DEMO AID (so a real Google account that isn't pre-seeded still gets a session
 * on the live site): ANY verified Google login resolves to Alice. A production
 * directory instead maps a specific (iss, sub) → agent via a real indexer +
 * on-chain `confirmsCredential` (and routes a brand-new subject to bootstrap,
 * spec 220). This catch-all is purely a demo convenience, clearly fenced to the
 * Google issuer.
 */
export function buildDemoDirectory(): IdentityDirectory {
  const inMem = createInMemoryIndexer(indexEntries);
  return createDirectory({
    naming: makeNamingPort({
      client: {
        resolveName: async (name: string) => NAMES[name] ?? null,
        reverseResolve: async (addr: Address) => reverseNames[addr.toLowerCase()] ?? null,
      },
      chainId: CHAIN,
    }),
    onChain: makeOnChainReadPort({
      exists: async (id) => id === ALICE || id === BOB,
      // Demo aid: confirm any Google login for Alice; otherwise the seeded set.
      confirmsCredential: async (id, p) => (isGoogleOidc(p) && id === ALICE) || onChainMembership.has(memberKey(id, p)),
    }),
    indexer: {
      agentsByCredential: (p) => inMem.agentsByCredential(p),
      // Demo aid: any Google subject proposes Alice; everything else is seeded.
      agentsByOidcSubject: async (iss, sub) =>
        iss === GOOGLE_ISS
          ? [{ agent: ALICE, assurance: 'asserted', ref: 'demo-google-catchall' }]
          : inMem.agentsByOidcSubject(iss, sub),
    },
  });
}

/** Resolve a (verified) credential → agent(s) and issue an aud-bound AgentSession. */
export async function issueForRelyingSite(
  directory: IdentityDirectory,
  signer: BrokerSigner,
  principal: CredentialPrincipal,
  aud: string,
  /** The Connect origin (the issuer). Server: `new URL(request.url).origin`. */
  iss: string,
): Promise<IssueOutcome> {
  const resolution = await directory.resolveByCredential(principal);
  return issueForResolution({ resolution, principal, signer, aud, iss, ttlSeconds: SESSION_TTL_SECONDS });
}

/**
 * Resolve a VERIFIED OIDC subject → agent(s) and issue an aud-bound AgentSession.
 * OIDC resolves via `resolveByOidcSubject(oidcIss, oidcSub)`, NOT
 * `resolveByCredential`: the (iss, sub) pair is the key, and both the demo
 * catch-all and a production indexer live on that path (identity-directory
 * doctrine — the broker passes the already-verified subject in). `principal` is
 * the login-grade OIDC facet; `connectIss` is the token issuer (the Connect origin).
 */
export async function issueForOidcSubject(
  directory: IdentityDirectory,
  signer: BrokerSigner,
  principal: CredentialPrincipal,
  oidcIss: string,
  oidcSub: string,
  aud: string,
  connectIss: string,
): Promise<IssueOutcome> {
  const resolution = await directory.resolveByOidcSubject(oidcIss, oidcSub);
  return issueForResolution({ resolution, principal, signer, aud, iss: connectIss, ttlSeconds: SESSION_TTL_SECONDS });
}

/** Relying-site side: verify a delivered token against a published JWKS. */
export async function verifyTokenWithJwks(
  jwks: Parameters<typeof importJwks>[0],
  token: string,
  aud: string,
  /** Expected issuer — the Connect origin (browser: `window.location.origin`). */
  expectedIss: string,
): Promise<VerifyResult> {
  const keys = await importJwks(jwks);
  return verifyAgentSession(token, { keys, expectedIss, expectedAud: aud });
}

/** Step-up gate: custody-class actions need a custody-grade credential. */
export function canPerform(session: AgentSession, action: string): { ok: boolean; reason?: string } {
  if (!requiresStepUp(action)) return { ok: true };
  if (session.principal.role === 'custody-grade') return { ok: true };
  return {
    ok: false,
    reason: `"${action}" is a custody-class action; this session is ${session.principal.role ?? 'login-grade'}. Step up with a custody-grade credential (ADR-0017 / CN-2).`,
  };
}

/**
 * Build a BrokerSigner from a stored ES256 (ECDSA P-256) PRIVATE JWK (the server
 * path — the key lives in an env secret, not in the browser). Derives the public
 * key from the JWK's `x`/`y`. ES256 (not EdDSA) because the Cloudflare Workers
 * runtime (`workerd`) does not support Ed25519 in Web Crypto — ES256 is supported
 * everywhere (workerd, browsers, Node), and is the spec's designated algorithm
 * for cross-environment broker tokens (spec 224 §4).
 */
export async function signerFromPrivateJwk(
  jwk: JsonWebKey & { x?: string; y?: string },
  kid: string,
): Promise<BrokerSigner> {
  const alg: BrokerAlg = 'ES256';
  const params: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, params, false, ['sign']);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey,
    params,
    true,
    ['verify'],
  );
  return { kid, alg, privateKey, publicKey };
}
