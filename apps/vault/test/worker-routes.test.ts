// demo-mcp's HTTP boundary — first coverage of a 2177-line router with 27 routes.
//
// Three things here are worth a test more than the routing is:
//
//   THE OAUTH INGRESS IS DOUBLY DISABLED. It 404s unless `DEMO_OAUTH_MINT_ENABLED === 'true'`, and
//   even then 501s without a signing secret. Two independent gates, so neither a stray flag nor a
//   present secret alone opens a public token mint — and the 404 (not 403) means a disabled deployment
//   does not advertise that the endpoint was ever interesting.
//
//   THE DEV SEEDER MUST NOT EXIST IN PRODUCTION (audit M3). The guard wraps the route REGISTRATION,
//   not the handler body, so on a production Worker the path is genuinely absent and Hono 404s it
//   naturally. That distinction only shows up in a test that loads the module twice under different
//   NODE_ENV — a handler-body guard would look identical from the outside while still being a route.
//
//   MCP IS PRIVATE, AND THE DISCOVERY DOC IS INGRESS METADATA, NEVER AUTHORITY (ADR-0041). The RFC
//   9728 document tells a client where to authenticate; it must not carry anything that decides.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGIN = 'https://client.example.test';
const PRINCIPAL = '0x1111111111111111111111111111111111111111';

const env = (over: Record<string, unknown> = {}) => ({
  MCP_AUDIENCE: 'https://mcp.example.test/mcp',
  RPC_URL: 'https://rpc.example.test',
  CHAIN_ID: '84532',
  ...over,
}) as never;

async function loadApp() {
  vi.resetModules();
  return (await import('../src/index.js')).default;
}

const call = async (app: { fetch: (r: Request, e: never) => Promise<Response> }, path: string, init: RequestInit = {}, e = env()) =>
  app.fetch(new Request(`https://mcp.example.test${path}`, init), e);

let app: Awaited<ReturnType<typeof loadApp>>;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(async () => { app = await loadApp(); });
afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('liveness and unknown paths', () => {
  it('answers /health', async () => {
    expect((await call(app, '/health')).status).toBe(200);
  });

  it('404s an unknown path rather than falling through', async () => {
    expect((await call(app, '/not/a/route')).status).toBe(404);
  });

  it('does not answer a GET on a POST-only tool route', async () => {
    expect((await call(app, '/tools/get_profile')).status).not.toBe(200);
  });
});

describe('the OAuth ingress is doubly disabled', () => {
  const mint = (e: never) => call(app, '/oauth/token', {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: PRINCIPAL }),
  }, e);

  // 404, NOT 403: a disabled deployment should not advertise that this endpoint exists at all.
  it('404s when the mint flag is unset', async () => {
    expect((await mint(env())).status).toBe(404);
  });

  it('404s for any value of the flag other than the exact string "true"', async () => {
    for (const v of ['TRUE', '1', 'yes', 'true ', '']) {
      expect((await mint(env({ DEMO_OAUTH_MINT_ENABLED: v }))).status, v).toBe(404);
    }
  });

  // The SECOND gate. A stray flag alone must not open a public token mint — the signing secret is an
  // independent precondition, and its absence is 501 (unimplemented here) rather than a mint.
  it('501s when the flag is on but no signing secret is configured', async () => {
    const r = await mint(env({ DEMO_OAUTH_MINT_ENABLED: 'true' }));
    expect(r.status).toBe(501);
    expect((await r.json() as { error: string }).error).toBe('unsupported');
  });

  it('still refuses a malformed body once both gates are open', async () => {
    const r = await call(app, '/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }, env({ DEMO_OAUTH_MINT_ENABLED: 'true', OAUTH_SIGNING_SECRET: 'secret' }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});

describe('RFC 9728 discovery is metadata, never authority (ADR-0041)', () => {
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'serves %s', async (path) => {
      const r = await call(app, path);
      expect(r.status).toBe(200);
      expect(await r.json()).toBeTruthy();
    },
  );

  // My first version of this asserted the document contained no "delegation" at all — and it does,
  // because `delegation:read`/`delegation:write` are advertised SCOPE NAMES. That was the wrong test:
  // ADR-0041's rule is that scopes never DECIDE (`vault:read` ≠ "decrypt all PII"), not that the word
  // may not appear. Advertising a scope name in RFC 9728 metadata is exactly what the document is for.
  //
  // What must NOT be there is anything decision-bearing or per-caller: a hash, a caveat, a field list,
  // a principal. An unauthenticated GET that carried any of those would be leaking the authority model.
  it('advertises scope NAMES but carries nothing decision-bearing', async () => {
    const body = await (await call(app, '/.well-known/oauth-protected-resource')).text();
    expect(body).toContain('delegation:read'); // a scope name — expected
    for (const forbidden of ['sha256:', 'caveat', 'allowedFields', 'ap_grant', 'delegationHash', PRINCIPAL]) {
      expect(body.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  // Unauthenticated metadata must be identical for every caller: varying it would make an anonymous
  // probe a way to learn something about a principal.
  it('is the same document regardless of who asks', async () => {
    const a = await (await call(app, '/.well-known/oauth-protected-resource', { headers: { origin: ORIGIN } })).text();
    const b = await (await call(app, '/.well-known/oauth-protected-resource', { headers: { origin: 'https://someone-else.test', authorization: 'Bearer whatever' } })).text();
    expect(a).toBe(b);
  });
});

describe('the dev seeder does not exist in production (audit M3)', () => {
  // Guarded at REGISTRATION, so this is a genuine 404 from an absent route rather than a handler
  // refusing. The difference is invisible from outside a single request, which is exactly why it is
  // asserted by loading the module twice.
  it('is ABSENT under NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const prodApp = await loadApp();
    const r = await call(prodApp, '/_dev/seed', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: PRINCIPAL }),
    });
    expect(r.status).toBe(404);
  });

  it('is PRESENT outside production, so the guard is doing real work', async () => {
    process.env.NODE_ENV = 'development';
    const devApp = await loadApp();
    const r = await call(devApp, '/_dev/seed', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    // Reached the handler: it refuses the missing address with a 400 rather than 404ing the path.
    expect(r.status).toBe(400);
  });
});

describe('vault-key custody endpoints refuse before they act', () => {
  it('answers the server-info probe', async () => {
    const r = await call(app, '/custody/vault-key/server-info');
    expect(r.status).toBeLessThan(500);
  });

  // Provisioning wields an ADMIN KMS credential and creates a real, cost-bearing per-owner KEK, so an
  // unproven caller must never reach it (the `principal-proof` gate, exercised here through the route).
  it('REFUSES provisioning without a control proof', async () => {
    const r = await call(app, '/custody/vault-key/provision', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: PRINCIPAL }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('REFUSES a binding submission with no authorization', async () => {
    const r = await call(app, '/custody/vault-key/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('malformed input answers rather than crashes', () => {
  // The class of bug `validate.ts` and the A2A dispatcher fix both address, checked at this boundary.
  it.each(['/mcp/v2', '/mcp/native', '/tools/get_profile'])(
    '%s answers unparseable JSON without a 5xx', async (path) => {
      const r = await call(app, path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all',
      });
      expect(r.status, path).toBeLessThan(500);
    },
  );

  // `/mcp` is EXCLUDED above and gets its own case: with no `OAUTH_SIGNING_SECRET` it answers 501
  // before reading the body at all, so its status says "this ingress is not configured here" rather
  // than anything about the JSON. Asserting <500 on it would have read as a crash-free result while
  // actually testing the config gate — a false pass.
  it('/mcp refuses as UNCONFIGURED before it looks at the body', async () => {
    for (const body of ['not json at all', '', '{"jsonrpc":"2.0"}']) {
      const r = await call(app, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(r.status).toBe(501);
      expect((await r.json() as { error: string }).error).toBe('unsupported');
    }
  });

  it('/mcp answers malformed JSON without a 5xx once the ingress IS configured', async () => {
    const r = await call(app, '/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all',
    }, env({ OAUTH_SIGNING_SECRET: 'secret' }));
    expect(r.status).toBeLessThan(500);
  });

  // An unauthenticated tool call must be refused as AUTH, not surfaced as an internal error — the
  // distinction a caller needs, and the one a thrown exception erases.
  it('refuses an unauthenticated tool call as an auth failure', async () => {
    const r = await call(app, '/tools/get_pii', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: PRINCIPAL }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
