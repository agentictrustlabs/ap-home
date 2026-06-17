// demo-mcp's OAuth ingress shell (spec 277 Phase 6 / §6–§8, §15).
//
// This is the APP-side authorization-server + JWT glue that
// `@agenticprimitives/mcp-oauth` deliberately does NOT own (the package is the
// transport-agnostic compat bridge; signature verification + the encrypted
// bundle store are app-supplied). It provides exactly enough to let a public
// HTTP MCP client talk to demo-mcp:
//
//   1. A demo authorization endpoint (`mintDemoMcpToken`) that synthesizes an
//      Agentic Grant Bundle, DOGFOODS the vault to store it encrypted, and mints
//      an HS256 bearer token that carries only a ref + hash to the bundle.
//   2. An injected `verify` (`createHs256Verify`) for
//      `validateMcpBearerToken` — HS256 with explicit alg-confusion rejection.
//   3. A vault-backed `GrantBundleStore` so `resolveGrantBundleFromToken` reads
//      the bundle straight out of the encrypted vault (no second store).
//
// Demo-grade, by design: HS256 with a shared secret stands in for a real
// AS/JWKS, and the bundle's delegation/entitlement/policy hashes are
// illustrative — the REAL authority chain (entitlement → KAS → required audit →
// projected decrypt) re-runs server-side off `ap_principal` on every `/mcp`
// call, so the token is never trusted as authority. A production deployment
// swaps this module for a real authorization server + JWKS verification and a
// managed bundle store; nothing in `@agenticprimitives/mcp-oauth` changes.

import {
  createMcpGrantBundle,
  bindOAuthTokenToGrantBundle,
  type McpAccessTokenClaims,
  type McpGrantBundleV1,
  type GrantBundleStore,
  type Sha256,
} from '@agenticprimitives/mcp-oauth';
import { demoVault } from './vault.js';

interface OAuthEnv {
  DB: D1Database;
  VAULT_MASTER_KEY?: string;
  A2A_ALLOW_LOCAL_ENVELOPE_KEY?: string;
  OAUTH_SIGNING_SECRET?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── base64url + HS256 (WebCrypto only) ──────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign an HS256 JWT over the given claims. */
export async function signHs256(claims: McpAccessTokenClaims, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64urlEncode(enc.encode(JSON.stringify(header)))}.${b64urlEncode(enc.encode(JSON.stringify(claims)))}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(signingInput) as unknown as ArrayBuffer));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Build the injected `verify` for `validateMcpBearerToken`: verify the HS256
 * signature and decode the claims. Returns `null` on any structural/signature
 * failure (the package maps that to `signature_invalid`/`malformed`). Rejects
 * `alg` confusion explicitly (only `HS256` accepted — never `none`/`RS256`).
 */
export function createHs256Verify(secret: string): (token: string) => Promise<McpAccessTokenClaims | null> {
  return async (token: string): Promise<McpAccessTokenClaims | null> => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    const key = await hmacKey(secret);
    let ok: boolean;
    try {
      ok = await globalThis.crypto.subtle.verify('HMAC', key, b64urlDecode(s) as unknown as ArrayBuffer, enc.encode(`${h}.${p}`) as unknown as ArrayBuffer);
    } catch {
      return null;
    }
    if (!ok) return null;
    try {
      const header = JSON.parse(dec.decode(b64urlDecode(h))) as { alg?: string };
      if (header.alg !== 'HS256') return null; // fail-closed on alg confusion
      return JSON.parse(dec.decode(b64urlDecode(p))) as McpAccessTokenClaims;
    } catch {
      return null;
    }
  };
}

// ─── local sha256 (the bundle's illustrative demo hashes) ─────────────────

async function sha256(input: string): Promise<Sha256> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(input) as unknown as ArrayBuffer);
  return `sha256:${Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ─── vault-backed grant-bundle store ──────────────────────────────────────

/**
 * Grant bundles are stored ENCRYPTED in the same vault as the PII (dogfooding
 * the vault as the bundle store), keyed by the bundle's full urn id under the
 * principal that owns the referenced data. The resolver looks them up by that
 * id. Absent → `null` → the package's resolver fails closed (`not_found`).
 */
export function grantBundleResource(grantId: string): string {
  return grantId; // the `urn:ap:mcp-grant:<uuid>` id is itself the vault resource
}

export function createVaultGrantBundleStore(env: OAuthEnv, owner: string): GrantBundleStore {
  const vault = demoVault(env);
  return {
    async get(id: string): Promise<McpGrantBundleV1 | null> {
      const obj = await vault.read<McpGrantBundleV1>({ owner, resource: grantBundleResource(id) });
      return obj?.data ?? null;
    },
  };
}

// ─── demo authorization endpoint ──────────────────────────────────────────

export interface MintDemoTokenInput {
  /** The SA whose data the token authorizes reading (becomes `sub` + `ap_principal`). */
  principal: string;
  /** The MCP resource identifier (becomes `aud`/`resource`). */
  audience: string;
  /** The authorization-server issuer (this Worker's origin). */
  issuer: string;
  clientId?: string;
  scopes?: string[];
  fields?: string[];
  purpose?: string;
  ttlSeconds?: number;
}

export interface MintDemoTokenResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  grant_ref: McpGrantBundleV1['id'];
}

const DEFAULT_SCOPES = ['mcp:invoke', 'vault:read', 'vault:pii:read'];
const DEFAULT_TTL_SECONDS = 300;

/**
 * Demo authorization: synthesize an Agentic Grant Bundle, store it encrypted in
 * the vault, and mint an HS256 bearer token bound to the bundle by ref + hash
 * (never carrying the delegation/entitlement payload — spec 277 §8).
 */
export async function mintDemoMcpToken(env: OAuthEnv, input: MintDemoTokenInput): Promise<MintDemoTokenResult> {
  if (!env.OAUTH_SIGNING_SECRET) {
    throw new Error('mintDemoMcpToken: OAUTH_SIGNING_SECRET is required to mint demo MCP tokens (spec 277 Phase 6).');
  }
  const now = new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttl;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(exp * 1000).toISOString();
  const scopes = input.scopes ?? DEFAULT_SCOPES;
  const clientId = input.clientId ?? 'demo-mcp-client';

  const id = `urn:ap:mcp-grant:${globalThis.crypto.randomUUID()}` as const;
  const bundle = await createMcpGrantBundle({
    id,
    oauth: { issuer: input.issuer, clientId, subject: input.principal, audience: input.audience, scopes },
    principal: { id: input.principal },
    mcp: { resourceUri: input.audience, serverId: 'demo-mcp' },
    delegation: {
      // Illustrative demo hashes — the real authority chain re-runs server-side
      // off `ap_principal` in /mcp (owner-reads-own via the entitlement resolver).
      delegationHash: await sha256(`demo-delegation:${input.principal}`),
      expiresAt,
      caveatsHash: await sha256(`demo-caveats:${input.principal}`),
      revocation: { mode: 'none' },
    },
    entitlements: [],
    constraints: { maxTtlSeconds: ttl, redactByDefault: true },
    replay: { jtiSeed: globalThis.crypto.randomUUID(), nonceScope: 'oauth-token' },
    policy: { profile: 'mcp-delegated-vault-v1', policyHash: await sha256(`demo-policy:${input.audience}`), toolPolicyVersion: '1' },
    issuedAt,
    expiresAt,
    status: 'active',
  });

  // Dogfood the vault: store the bundle encrypted under the principal.
  await demoVault(env).write({
    owner: input.principal,
    resource: grantBundleResource(id),
    data: bundle,
    classification: 'delegation.private',
  });

  const binding = bindOAuthTokenToGrantBundle(bundle);
  const claims: McpAccessTokenClaims = {
    iss: input.issuer,
    sub: input.principal,
    aud: input.audience,
    resource: input.audience,
    client_id: clientId,
    jti: globalThis.crypto.randomUUID(),
    iat,
    exp,
    scope: scopes.join(' '),
    ...binding,
  };
  const access_token = await signHs256(claims, env.OAUTH_SIGNING_SECRET);
  return { access_token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' '), grant_ref: id };
}
