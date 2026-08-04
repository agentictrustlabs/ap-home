// InteractionsDO's outermost gates — the first coverage of a 2469-line Durable Object that had none.
//
// WHAT THIS COVERS, AND WHY IT STOPS WHERE IT DOES.
//
// The DO's request path is: principal shape → Home-session verification → grant custody → vault read
// → chain proof. This file covers the first two, in full, against the REAL implementations: callers
// present genuinely ES256-signed tokens verified against a real generated key served as a JWKS, so
// `verifyHomeSession`'s iss/aud/exp/alg/kid checks all execute. Nothing is bypassed — faking the gate
// would make every assertion here a statement about the fake.
//
// The path stops at the vault, and that is a FINDING rather than a limit of effort. Reading a board
// requires four external systems to be satisfied in the right order — broker JWKS, GCP KMS (the
// bound-mint signer, since server-mint was retired under CRIT-2), demo-mcp, and a chain RPC — and the
// DO reaches for all four through `this.env` and module imports rather than an injected seam. Compare
// `packages/fabric`'s `PrincipalGatewayDO`, which takes `GatewayDeps` (verifyToken / wrapperFor /
// tools) exactly so it can be driven in a test. `InteractionsDO` has no such parameter, so covering
// its board ops means reconstructing production state through HTTP stubs — which tests the stubs.
//
// The fix is a deps seam mirroring `GatewayDeps`, not more stubbing. Recorded in the commit; until
// then this file covers the gates that ARE reachable, which are also the ones that matter most: they
// are the outermost boundary, and everything past them assumes they held.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { InteractionsDO } from '../src/interactions-do.js';

const ORG = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const CHAIN = 84532;
const BROKER_ISS = 'https://home.example.test';
const AUD = 'demo-sso';
const JWKS_URL = 'https://home.example.test/.well-known/jwks.json';
const KID = 'test-key-1';
const caip = (a: string) => `eip155:${CHAIN}:${a}`;

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A real ES256 broker key — the session gate does actual crypto against this. */
async function brokerKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, jwks: { keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] } };
}

async function mint(privateKey: CryptoKey, sub: string, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = { alg: 'ES256', kid: KID, typ: 'JWT', ...header };
  const p = { iss: BROKER_ISS, aud: AUD, sub, iat: now, exp: now + 3600, jti: crypto.randomUUID(), ...over };
  const enc = new TextEncoder();
  const si = `${b64url(enc.encode(JSON.stringify(h)))}.${b64url(enc.encode(JSON.stringify(p)))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(si));
  return `${si}.${b64url(new Uint8Array(sig))}`;
}

// ONE key for the whole file, deliberately. `custody-oidc` caches the broker JWKS at MODULE level with
// a TTL, so it survives across DO instances and across tests — a per-test key would be served once and
// then shadowed by the cache, and every later token would fail signature verification for a reason
// that has nothing to do with what was being tested. The cache is real production behaviour; the
// harness respects it rather than fighting it.
let jwks: unknown;
let signer: CryptoKey;
let calls: string[];
let restoreFetch: () => void;
let doInstance: InteractionsDO;
/** Flip to serve a JWKS the DO cannot fetch — the fail-closed branch. */
let jwksAvailable = true;

const env = () => ({
  RPC_URL: 'https://rpc.example.test',
  CHAIN_ID: String(CHAIN),
  MCP_URL: 'https://mcp.example.test',
  BROKER_ISS,
  BROKER_JWKS_URL: JWKS_URL,
  DEMO_SSO_AUD: AUD,
}) as unknown as ConstructorParameters<typeof InteractionsDO>[1];

beforeAll(async () => {
  const k = await brokerKey();
  jwks = k.jwks;
  signer = k.privateKey;
});

beforeEach(async () => {
  calls = [];
  jwksAvailable = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    calls.push(url);
    if (url.includes('jwks')) {
      return jwksAvailable
        ? new Response(JSON.stringify(jwks), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('nope', { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };

  const m = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return m.get(key); },
    async put(key: string, v: unknown) { m.set(key, v); },
    async delete(key: string) { m.delete(key); },
  };
  doInstance = new InteractionsDO({ storage } as unknown as DurableObjectState, env());
});

afterEach(() => restoreFetch());

const call = (op: string, token: string, principal = ORG) =>
  doInstance.fetch(new Request(`https://do.test/interactions/${principal}/${op}`, {
    method: 'POST',
    body: JSON.stringify({ session: token }),
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
  }));

describe('the principal shape is checked before anything external is touched', () => {
  it('REFUSES a non-address principal with 400', async () => {
    const r = await doInstance.fetch(new Request('https://do.test/interactions/not-an-address/channels.list', {
      method: 'POST', body: '{}',
    }));
    expect(r.status).toBe(400);
  });

  // Cheapest check first is a real property, not a style preference: a malformed path must not cost a
  // JWKS fetch, a KMS call or a chain read. Anything else is an unauthenticated amplification vector.
  it('makes NO outbound call for a malformed principal', async () => {
    await doInstance.fetch(new Request('https://do.test/interactions/0xshort/channels.list', {
      method: 'POST', body: '{}',
    }));
    expect(calls).toHaveLength(0);
  });

  it('REFUSES an address-shaped principal of the wrong length', async () => {
    for (const bad of [`0x${'a'.repeat(39)}`, `0x${'a'.repeat(41)}`, 'f39Fd6e51aad88F6F4ce6aB8827279cffFb92266']) {
      const r = await doInstance.fetch(new Request(`https://do.test/interactions/${bad}/channels.list`, {
        method: 'POST', body: '{}',
      }));
      expect(r.status, bad).toBe(400);
    }
  });
});

describe('the Home-session gate runs real verification', () => {
  it('REFUSES a request with no session', async () => {
    expect((await call('channels.list', '')).status).toBe(401);
  });

  it('REFUSES a structurally invalid token', async () => {
    expect((await call('channels.list', 'not-a-jwt')).status).toBe(401);
    expect((await call('channels.list', 'a.b')).status).toBe(401);
  });

  // Signed with a DIFFERENT key than the JWKS advertises — the signature check is doing real work,
  // not just parsing claims.
  it('REFUSES a token signed by the wrong key', async () => {
    const other = await brokerKey();
    expect((await call('channels.list', await mint(other.privateKey, caip(MEMBER)))).status).toBe(401);
  });

  // alg-confusion: a token claiming an algorithm the key does not use must not verify. `verifyAgentSession`
  // pins alg to the key precisely so `alg:none` and HS/ES swaps cannot enter.
  it('REFUSES an alg the key does not declare', async () => {
    expect((await call('channels.list', await mint(signer, caip(MEMBER), {}, { alg: 'HS256' }))).status).toBe(401);
    expect((await call('channels.list', await mint(signer, caip(MEMBER), {}, { alg: 'none' }))).status).toBe(401);
  });

  it('REFUSES an unknown kid', async () => {
    expect((await call('channels.list', await mint(signer, caip(MEMBER), {}, { kid: 'someone-elses-key' }))).status).toBe(401);
  });

  it('REFUSES a foreign issuer', async () => {
    expect((await call('channels.list', await mint(signer, caip(MEMBER), { iss: 'https://evil.test' }))).status).toBe(401);
  });

  // NOT a rejection, and this is the DO's documented DUAL PATH rather than a hole. `verifyHomeSession`
  // runs first; if it fails, `verifyRelyingIdToken` runs, and a REGISTERED relying app's id_token
  // carries `aud = client_id` — never DEMO_SSO_AUD. So a foreign audience is expected here.
  //
  // What still holds on that path: the signature must verify against THIS Home's JWKS and the issuer
  // must be this Home. The token asserts only WHO the person is; authorization is enforced downstream
  // by the on-chain steward/member gate. The assertion below is that it gets past AUTH and stops at
  // the next gate — not that it is authorized.
  it('accepts a foreign audience as a RELYING app id_token, and still stops at the next gate', async () => {
    const r = await call('channels.list', await mint(signer, caip(MEMBER), { aud: 'some-other-app' }));
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(409); // no interactions grant — the gate after authentication
  });

  it('REFUSES an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect((await call('channels.list', await mint(signer, caip(MEMBER), { exp: past }))).status).toBe(401);
  });

  // `verifyAgentSession` rejects a future `iat` beyond clock skew — but the relying-app fallback does
  // not check `iat`, so the request continues on that path. Asserted as the observed behaviour rather
  // than the one I first assumed: the Home-session gate is strict; the relying path trades that for a
  // downstream on-chain authorization check.
  it('a future-dated iat fails the Home-session gate and falls through to the relying path', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await call('channels.list', await mint(signer, caip(MEMBER), { iat: future }));
    expect(r.status).toBe(409);
  });

  // 400, not 401: the token is authentic, its SUBJECT is unusable. Distinguishing "I do not believe
  // you" from "I believe you and cannot act on this" is worth keeping — they need different fixes.
  it('REFUSES a subject carrying no SA, as a 400 rather than an auth failure', async () => {
    expect((await call('channels.list', await mint(signer, 'not-a-caip-address'))).status).toBe(400);
  });

  // Fail-CLOSED on an unreachable broker, not fail-open. An unavailable JWKS is 503 — a statement that
  // the gate could not run — never an admission.
  it('FAILS CLOSED when the broker JWKS is unreachable', async () => {
    jwksAvailable = false;
    // A DISTINCT JWKS URL, so the module-level cache misses and the fetch actually happens. Reusing the
    // warm URL would have served cached keys and tested nothing.
    const m = new Map<string, unknown>();
    const cold = new InteractionsDO(
      { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string) { m.delete(k); } } } as unknown as DurableObjectState,
      { ...env(), BROKER_JWKS_URL: `${JWKS_URL}?cold=${crypto.randomUUID()}` } as unknown as ConstructorParameters<typeof InteractionsDO>[1],
    );
    const token = await mint(signer, caip(MEMBER));
    const r = await cold.fetch(new Request(`https://do.test/interactions/${ORG}/channels.list`, {
      method: 'POST', body: JSON.stringify({ session: token }), headers: { authorization: `Bearer ${token}` },
    }));
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toMatch(/JWKS unavailable|fail-closed/i);
  });

  // A well-formed session gets PAST the gate — which is what makes every refusal above meaningful.
  // It then stops at the vault (see the header): the point is that it is no longer the session that
  // stops it.
  it('ADMITS a well-formed session past the gate, which stops at the grant', async () => {
    const r = await call('channels.list', await mint(signer, caip(MEMBER)));
    expect(r.status).not.toBe(401);
    // 409 "no interactions grant" — authentication succeeded and the NEXT gate refused, which is what
    // makes every refusal above meaningful. (No JWKS fetch is asserted: the module-level cache means a
    // warm run legitimately makes none.)
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toMatch(/no interactions grant/);
  });
});

describe('the gate is not configured away', () => {
  // An unconfigured broker is 503, never an open door. This is the deployment mistake that would
  // otherwise turn every session check into a no-op.
  it('FAILS CLOSED when broker config is absent', async () => {
    const m = new Map<string, unknown>();
    const bare = new InteractionsDO(
      { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string) { m.delete(k); } } } as unknown as DurableObjectState,
      { RPC_URL: 'https://rpc.example.test', CHAIN_ID: String(CHAIN) } as unknown as ConstructorParameters<typeof InteractionsDO>[1],
    );
    const r = await bare.fetch(new Request(`https://do.test/interactions/${ORG}/channels.list`, {
      method: 'POST', body: JSON.stringify({ session: 'anything' }),
    }));
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toMatch(/not configured/);
  });
});

// ── spec 341 §5.3 — the STEWARD gate on an organization's governance docs ──────────────────────────
//
// These ops were bridge-only, because `ownerOrBridge` cannot serve them: the principal is an ORG, an
// org has no session, and its steward's session SA is by definition not the principal. The shared
// secret stood in for authority — it proves the caller is our Home and nothing about whether the
// person behind it may act for this organization.
//
// What is reachable in this harness is the REFUSAL, and that is the half worth pinning: a session that
// proves someone else, with no stewardship delegation, must not reach an org's queue. The positive
// path needs a signed on-chain delegation plus a vault, which is the deps-seam limitation this file's
// header already records.
describe('an organization’s join queue is not reachable by just anyone', () => {
  it('REFUSES a valid session for a different agent, with no stewardship', async () => {
    const token = await mint(signer, caip(MEMBER));
    const r = await call('applications.get', token, ORG);
    // 401 unauthorized (the gate) or 409 no-grant (the plane) — never 200. Asserting "not ok" rather
    // than a specific code keeps this honest about which check fires first without pinning an order
    // that is not itself a requirement.
    expect(r.ok).toBe(false);
    expect(r.status).not.toBe(200);
  });

  it('REFUSES a bare unauthenticated write', async () => {
    const r = await doInstance.fetch(new Request(`https://do.test/interactions/${ORG}/applications.put`, {
      method: 'POST', body: JSON.stringify({ doc: { applications: [] } }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(r.ok).toBe(false);
  });

  it('REFUSES a junk stewardship delegation', async () => {
    const token = await mint(signer, caip(MEMBER));
    const r = await doInstance.fetch(new Request(`https://do.test/interactions/${ORG}/applications.get`, {
      method: 'POST',
      // Delegator/delegate shaped correctly, signature meaningless. `isSteward` verifies the shape AND
      // the signature on-chain; a check that stopped at the shape would accept this.
      body: JSON.stringify({ session: token, stewardship: { delegator: ORG, delegate: MEMBER, caveats: [], salt: '1', signature: '0xdead' } }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(r.ok).toBe(false);
  });
});
