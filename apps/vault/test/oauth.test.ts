// The OAuth ingress envelope (spec 277 §6–§8, ADR-0041) — untested until now.
//
// THE INVARIANT THIS FILE EXISTS FOR: on this substrate OAuth is a TRANSPORT ENVELOPE, never
// authority. The bearer may carry at most `ap_principal` plus a REF and HASH to an encrypted grant
// bundle. It must never carry delegation or entitlement payload, and never field-level authority —
// because the moment a scope string can widen access, the Web3 gate (delegation + signature +
// entitlement + tool policy, re-run server-side) has been quietly replaced by an issuer's opinion.
//
// So the load-bearing test here is not "does the JWT round-trip". It is: mint a token and prove that
// nothing decision-bearing is INSIDE it. That test is written to fail if someone later inlines a
// caveat "for convenience" — which is exactly how this drifts, and the repo has already lived through
// the same drift once when MCP's standards were adopted.
//
// The rest is the alg-confusion surface. A verifier that accepted `none` or `RS256` would let anyone
// mint their own principal, and a shared-secret demo AS makes that a one-line mistake.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SECRET = 'demo-signing-secret-value';
const PRINCIPAL = '0x1111111111111111111111111111111111111111';
const AUDIENCE = 'https://mcp.example.test/mcp';
const ISSUER = 'https://mcp.example.test';

/** An in-memory stand-in for the principal's per-person encrypted vault (spec 278). */
const written = new Map<string, unknown>();
let hasBinding = true;

vi.mock('../src/vault-key.js', () => ({
  resolvePersonVault: async (_env: unknown, owner: string) =>
    hasBinding
      ? {
          vault: {
            async write({ resource, data }: { resource: string; data: unknown }) { written.set(`${owner}|${resource}`, data); },
            async read<T>({ resource }: { resource: string }) {
              const d = written.get(`${owner}|${resource}`);
              return d === undefined ? null : ({ data: d as T });
            },
          },
        }
      : null,
}));

const {
  signHs256, createHs256Verify, grantBundleResource, createVaultGrantBundleStore, mintDemoMcpToken,
} = await import('../src/oauth.js');

const env = (over: Record<string, unknown> = {}) => ({ OAUTH_SIGNING_SECRET: SECRET, ...over }) as never;

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

beforeEach(() => { written.clear(); hasBinding = true; });

describe('HS256 sign and verify', () => {
  const claims = { iss: ISSUER, sub: PRINCIPAL, aud: AUDIENCE, jti: 'j1', iat: 1, exp: 2 } as never;

  it('round-trips claims', async () => {
    const token = await signHs256(claims, SECRET);
    expect(await createHs256Verify(SECRET)(token)).toMatchObject({ sub: PRINCIPAL, aud: AUDIENCE });
  });

  it('REJECTS a token signed with a different secret', async () => {
    const token = await signHs256(claims, 'some-other-secret');
    expect(await createHs256Verify(SECRET)(token)).toBeNull();
  });

  // Tampering the payload invalidates the signature — the property that makes the ref/hash binding in
  // the claims trustworthy at all.
  it('REJECTS a token whose payload was edited after signing', async () => {
    const token = await signHs256(claims, SECRET);
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...claims, sub: '0xdeadbeef' }))}.${s}`;
    expect(await createHs256Verify(SECRET)(forged)).toBeNull();
  });

  it.each([['two parts', 'a.b'], ['one part', 'abc'], ['four parts', 'a.b.c.d'], ['empty', '']])(
    'REJECTS a structurally invalid token (%s)', async (_n, token) => {
      expect(await createHs256Verify(SECRET)(token)).toBeNull();
    },
  );

  it('REJECTS a token whose signature segment is not decodable', async () => {
    const token = await signHs256(claims, SECRET);
    const [h, p] = token.split('.');
    expect(await createHs256Verify(SECRET)(`${h}.${p}.!!!not-base64!!!`)).toBeNull();
  });
});

describe('alg confusion is refused explicitly', () => {
  // A verifier that trusted the header's `alg` would let a caller present `none` and mint their own
  // principal. The check is made AFTER signature verification, so these are tokens that are correctly
  // HMAC-signed and still refused for claiming a different algorithm.
  it.each(['none', 'RS256', 'ES256', 'HS512', ''])('REJECTS a validly-signed token claiming alg=%s', async (alg) => {
    const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: PRINCIPAL }));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)));
    const token = `${header}.${payload}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    expect(await createHs256Verify(SECRET)(token)).toBeNull();
  });

  it('REJECTS a header with no alg at all', async () => {
    const header = b64url(JSON.stringify({ typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: PRINCIPAL }));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)));
    const token = `${header}.${payload}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    expect(await createHs256Verify(SECRET)(token)).toBeNull();
  });
});

describe('THE ENVELOPE CARRIES NO AUTHORITY (ADR-0041 / spec 277 §8)', () => {
  const mint = () => mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER });

  it('mints a bearer bound to the bundle by ref and hash', async () => {
    const r = await mint();
    const claims = await createHs256Verify(SECRET)(r.access_token) as Record<string, unknown>;
    expect(claims.ap_grant_ref).toBe(r.grant_ref);
    expect(String(claims.ap_grant_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(claims.ap_principal).toBe(PRINCIPAL);
  });

  // THE TEST. Everything decision-bearing lives in the encrypted bundle; the token points at it. If a
  // delegation, a caveat, an entitlement or a field list ever appears in these claims, the bearer has
  // become authority and the Web3 gate has an issuer-shaped bypass.
  it('carries NO delegation, entitlement, caveat or field payload', async () => {
    const claims = await createHs256Verify(SECRET)((await mint()).access_token) as Record<string, unknown>;
    for (const key of Object.keys(claims)) {
      expect(key, `claim "${key}" looks decision-bearing`).not.toMatch(/caveat|entitlement|delegationhash|fields|policyhash|redact/i);
    }
    // The bundle's hashes are the detail. None of them may appear in the token.
    const serialized = JSON.stringify(claims);
    for (const secretish of ['demo-delegation:', 'demo-caveats:', 'demo-policy:']) {
      expect(serialized).not.toContain(secretish);
    }
  });

  // AN ALLOWLIST, not a denylist — the stronger form of the same invariant. A denylist only catches
  // the payload shapes someone thought to forbid; this fails on ANY new claim, so widening the
  // envelope becomes a deliberate act with a diff rather than something that slips in.
  //
  // `ap_grant_ref`/`ap_grant_hash` are POINTERS at the encrypted bundle; `ap_principal` is who the
  // request is for; `ap_policy_profile` is a profile LABEL, not a policy. None of the four decides
  // anything — the server re-runs delegation + entitlement + tool policy off `ap_principal` regardless.
  it('carries EXACTLY the claims the envelope is allowed to carry', async () => {
    const claims = await createHs256Verify(SECRET)((await mint()).access_token) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual([
      'ap_grant_hash', 'ap_grant_ref', 'ap_policy_profile', 'ap_principal',
      'aud', 'client_id', 'exp', 'iat', 'iss', 'jti', 'resource', 'scope', 'sub',
    ]);
  });

  // The bundle itself carries the detail — so the token being thin is a REAL separation rather than
  // the detail not existing. Asserted from the encrypted store the mint wrote to.
  it('the bundle DOES hold what the token withholds', async () => {
    const r = await mint();
    const bundle = written.get(`${PRINCIPAL}|${r.grant_ref}`) as { delegation: { delegationHash: string; caveatsHash: string }; policy: { policyHash: string } };
    expect(bundle.delegation.delegationHash).toMatch(/^sha256:/);
    expect(bundle.delegation.caveatsHash).toMatch(/^sha256:/);
    expect(bundle.policy.policyHash).toMatch(/^sha256:/);
  });

  it('scopes are advertised in the token but the bundle is the record', async () => {
    const r = await mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER, scopes: ['vault:read'] });
    expect(r.scope).toBe('vault:read');
    const claims = await createHs256Verify(SECRET)(r.access_token) as Record<string, unknown>;
    expect(claims.scope).toBe('vault:read');
    // And it is still not authority: the scope names an intent, the bundle+server decide.
    expect(claims.ap_grant_ref).toBe(r.grant_ref);
  });

  it('stores the bundle under the principal, classified as private delegation data', async () => {
    const r = await mint();
    expect(written.has(`${PRINCIPAL}|${r.grant_ref}`)).toBe(true);
  });

  it('mints a distinct grant per call — no bundle reuse across tokens', async () => {
    const [a, b] = [await mint(), await mint()];
    expect(a.grant_ref).not.toBe(b.grant_ref);
    expect(a.access_token).not.toBe(b.access_token);
  });
});

describe('minting fails closed', () => {
  // No secret ⇒ no token. A Worker deployed without it must not fall back to an unsigned bearer.
  it('THROWS without a signing secret', async () => {
    await expect(mintDemoMcpToken(env({ OAUTH_SIGNING_SECRET: undefined }), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER }))
      .rejects.toThrow(/OAUTH_SIGNING_SECRET/);
  });

  // spec 278: person data has no global key. A principal with no vault-key binding cannot have a
  // bundle stored, so the mint must fail rather than issue a token pointing at nothing.
  it('THROWS when the principal has no vault-key binding', async () => {
    hasBinding = false;
    await expect(mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER }))
      .rejects.toThrow(/vault-key binding/);
  });

  it('writes NOTHING when it fails', async () => {
    hasBinding = false;
    await mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER }).catch(() => undefined);
    expect(written.size).toBe(0);
  });
});

describe('the bundle store is the vault, and fails closed', () => {
  it('resolves a stored bundle by its urn id', async () => {
    const r = await mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER });
    const store = createVaultGrantBundleStore(env(), PRINCIPAL);
    expect((await store.get(r.grant_ref))?.id).toBe(r.grant_ref);
  });

  it('returns null for an unknown id rather than inventing one', async () => {
    expect(await createVaultGrantBundleStore(env(), PRINCIPAL).get('urn:ap:mcp-grant:nope')).toBeNull();
  });

  // No binding ⇒ null ⇒ the package's resolver fails closed with `not_found`. An absent key must never
  // read as an absent restriction.
  it('returns null when the owner has no vault-key binding', async () => {
    const r = await mintDemoMcpToken(env(), { principal: PRINCIPAL, audience: AUDIENCE, issuer: ISSUER });
    hasBinding = false;
    expect(await createVaultGrantBundleStore(env(), PRINCIPAL).get(r.grant_ref)).toBeNull();
  });

  // The id IS the resource — no second naming scheme to drift out of sync with the resolver.
  it('uses the grant id itself as the vault resource', () => {
    expect(grantBundleResource('urn:ap:mcp-grant:abc')).toBe('urn:ap:mcp-grant:abc');
  });
});
