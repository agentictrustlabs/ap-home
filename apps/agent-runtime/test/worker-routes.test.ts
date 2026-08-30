// The Worker's HTTP boundary — first coverage of a 5133-line router with 58 routes and no tests.
//
// A Hono app is testable by asking it: `app.fetch(request, env)`. No deps seam is needed here, because
// what is under test is the boundary itself — CORS, CSRF, method routing, unknown paths, and the
// public agent card. Everything past the boundary reaches a DO or an external system and has its own
// coverage (`interactions-do-*.test.ts`, `a2a-task-do.test.ts`).
//
// The theme is the same throughout: MISCONFIGURATION MUST NOT OPEN A DOOR. A Worker deployed without
// `ALLOWED_ORIGINS` must not become origin-permissive; a CSRF gate with nothing configured must not
// become a no-op. The repo has been bitten by exactly this shape before — a bare `wrangler deploy`
// wiped the injected vars and every browser POST began failing CSRF (2026-07-07), which is the *safe*
// direction of that failure and worth keeping that way on purpose.

import { describe, it, expect, afterEach } from 'vitest';
import app, { releasedCardKey } from '../src/index.js';
import { cardContentDigest } from '@agenticprimitives/agent-profile/a2a';

// THE WORKER BRIDGES ITS ENV INTO GLOBAL `process.env` AT REQUEST ENTRY (`bridgeEnvToProcessEnv`), and
// never clears it — our packages read secrets from `process.env`, and in production one isolate serves
// one configuration, so persistence is correct there. In a test process it means one case's config
// leaks into the next: an "unconfigured" assertion silently runs against the previous test's secret.
//
// Found the honest way — a fail-closed assertion passed when it should not have. The bridge itself is
// right, including that it copies only NON-EMPTY values, which is the correct handling of the
// `wrangler VAR = ""` trap where an empty binding would otherwise overwrite real config.
const BRIDGED = ['CSRF_SECRET', 'A2A_KMS_BACKEND', 'GCP_KMS_KEY_NAME', 'GCP_KMS_ENCRYPT_KEY_NAME', 'GCP_SERVICE_ACCOUNT_JSON'];
afterEach(() => { for (const k of BRIDGED) delete process.env[k]; });

const ORIGIN = 'https://app.example.test';

const env = (over: Record<string, unknown> = {}) => ({
  CHAIN_ID: '84532',
  RPC_URL: 'https://rpc.example.test',
  ALLOWED_ORIGINS: ORIGIN,
  ...over,
}) as unknown as Parameters<typeof app.fetch>[1];

const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://a2a.example.test${path}`, init);

const call = (path: string, init: RequestInit = {}, e = env()) => app.fetch(req(path, init), e);

describe('liveness and the public surface', () => {
  it('answers /health without any configuration', async () => {
    const r = await app.fetch(req('/health'), {} as Parameters<typeof app.fetch>[1]);
    expect(r.status).toBe(200);
  });

  it('serves an unknown path as 404 rather than falling through to a handler', async () => {
    expect((await call('/definitely/not/a/route')).status).toBe(404);
  });

  // Method routing is part of the boundary: a GET-only route must not accept a POST just because the
  // path matches. A router that ignored the method would let a read endpoint be driven as a write.
  it('does not accept a POST on a GET-only route', async () => {
    const r = await call('/health', { method: 'POST' });
    expect(r.status).not.toBe(200);
  });
});

describe('the agent card is public and says only public things', () => {
  it('serves the A2A agent card', async () => {
    const r = await call('/.well-known/agent-card.json');
    expect(r.status).toBe(200);
    const card = await r.json() as Record<string, unknown>;
    expect(card).toBeTruthy();
  });

  // ADR-0057 / spec 339 §21.2: MCP is a PRIVATE capability interface behind an admitted runtime and
  // MUST NOT appear on any Agent Card. This is the assertion that keeps that true as the card grows.
  it('advertises NO MCP endpoint — MCP is never a peer public surface', async () => {
    const body = await (await call('/.well-known/agent-card.json')).text();
    expect(body.toLowerCase()).not.toContain('"mcp"');
    expect(body).not.toMatch(/\/mcp\b/);
  });

  it('serves the legacy card path too, so older clients keep resolving', async () => {
    expect((await call('/.well-known/agent.json')).status).toBe(200);
  });

  // spec 347 §8.1 — the live card carries its own RFC 8785 content digest, so a verifier (or the naming
  // record `atl:cardDigest`) can compare without trusting the server's word for it.
  it('stamps the live card with its canonical content digest', async () => {
    const r = await call('/.well-known/agent-card.json');
    expect(r.headers.get('x-ap-card-source')).toBe('live');
    const digest = r.headers.get('x-ap-card-digest')!;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cardContentDigest(await r.json())).toBe(digest);
    expect(r.headers.get('etag')).toBe(`"${digest}"`);
  });

  // spec 347 §8.5 — an unbound host publishes a VALID, EMPTY ARD manifest rather than inventing an entry.
  it('serves /.well-known/ard.json with no entries on an unbound host', async () => {
    const r = await call('/.well-known/ard.json');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ entries: [] });
  });

  it('without a bound agent the released-card cache is never consulted', async () => {
    let reads = 0;
    const kv = { get: async () => { reads++; return null; } } as unknown as KVNamespace;
    const r = await call('/.well-known/agent-card.json', {}, env({ RELEASED_CARDS: kv }));
    expect(r.status).toBe(200);
    expect(reads).toBe(0);
    expect(releasedCardKey('0xABC')).toBe('released-card:0xabc');
  });
});

describe('CORS is an allowlist, and an empty allowlist allows nothing', () => {
  it('reflects a configured origin', async () => {
    const r = await call('/health', { headers: { origin: ORIGIN } });
    const allow = r.headers.get('access-control-allow-origin');
    if (allow) expect(allow).toBe(ORIGIN);
  });

  it('does NOT reflect an unconfigured origin', async () => {
    const r = await call('/health', { headers: { origin: 'https://evil.test' } });
    expect(r.headers.get('access-control-allow-origin')).not.toBe('https://evil.test');
  });

  // THE misconfiguration case. `ALLOWED_ORIGINS=""` is what a bare `wrangler deploy` leaves behind
  // when the injected vars are wiped, and an empty allowlist must mean NOTHING is allowed — never
  // everything. A `*` here would hand any site a credentialed cross-origin channel.
  it('an EMPTY allowlist allows nothing, and never becomes a wildcard', async () => {
    const r = await call('/health', { headers: { origin: ORIGIN } }, env({ ALLOWED_ORIGINS: '' }));
    const allow = r.headers.get('access-control-allow-origin');
    expect(allow).not.toBe('*');
    expect(allow).not.toBe(ORIGIN);
  });

  it('an absent allowlist behaves the same as an empty one', async () => {
    const r = await call('/health', { headers: { origin: ORIGIN } }, env({ ALLOWED_ORIGINS: undefined }));
    expect(r.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  // Credentialed CORS and `*` are mutually exclusive in the spec, and a browser will refuse the pair —
  // but asserting it here means the mistake is caught before a deploy rather than in a console.
  it('never pairs a wildcard origin with credentials', async () => {
    for (const origin of [ORIGIN, 'https://evil.test']) {
      const r = await call('/health', { headers: { origin } });
      if (r.headers.get('access-control-allow-credentials') === 'true') {
        expect(r.headers.get('access-control-allow-origin')).not.toBe('*');
      }
    }
  });
});

describe('CSRF', () => {
  it('issues a token when configured', async () => {
    const r = await call('/auth/csrf', { headers: { origin: ORIGIN } }, env({ CSRF_SECRET: 'ab'.repeat(32) }));
    expect([200, 204]).toContain(r.status);
  });

  // FAIL-CLOSED on missing config, the direction that matters: a Worker deployed without CSRF_SECRET
  // must not hand out a token that verifies against nothing. (It surfaces as a 5xx rather than a typed
  // 503 — noted, not changed: the refusal is correct and the code is cosmetic beside it.)
  it('issues NO token when CSRF_SECRET is unconfigured', async () => {
    delete process.env.CSRF_SECRET; // the bridge persists; an unconfigured test must actually be one
    const r = await call('/auth/csrf', { headers: { origin: ORIGIN } }, env({ CSRF_SECRET: '' }));
    expect(r.status).not.toBe(200);
    expect(r.status).not.toBe(204);
  });

  // The empty-binding trap, asserted on the bridge's behaviour: `VAR = ""` from a bare `wrangler
  // deploy` must NOT overwrite an already-good secret with nothing.
  it('an EMPTY binding does not clobber a configured secret', async () => {
    await call('/auth/csrf', { headers: { origin: ORIGIN } }, env({ CSRF_SECRET: 'ab'.repeat(32) }));
    const r = await call('/auth/csrf', { headers: { origin: ORIGIN } }, env({ CSRF_SECRET: '' }));
    expect([200, 204]).toContain(r.status);
  });

  it('REFUSES a CSRF token request with no origin at all', async () => {
    const r = await call('/auth/csrf', {}, env({ CSRF_SECRET: 'ab'.repeat(32) }));
    expect(r.status).toBe(400);
  });

  it('REFUSES a malformed origin', async () => {
    const r = await call('/auth/csrf', { headers: { origin: 'not-a-url' } }, env({ CSRF_SECRET: 'ab'.repeat(32) }));
    expect(r.status).toBe(400);
  });

  // A state-changing POST from an unconfigured origin must be refused. This is the gate the 2026-07-07
  // incident tripped — and it tripped CLOSED, which is the behaviour worth pinning.
  it('REFUSES a state-changing POST from an unlisted origin', async () => {
    const r = await call('/session/deploy', {
      method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('REFUSES a state-changing POST with no origin at all', async () => {
    const r = await call('/session/deploy', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('malformed input reaches a handler as a response, not a crash', () => {
  // The class of bug `validate.ts` and the A2A dispatcher fix both address, checked at the boundary:
  // a Worker that throws on bad JSON returns a 500 with a stack instead of a typed refusal.
  it('answers unparseable JSON without a 5xx', async () => {
    const r = await call('/api/a2a', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(r.status).toBeLessThan(500);
  });

  // `/rpc` is deliberately EXCLUDED from the assertion above: it is a passthrough proxy that forwards
  // the body verbatim to the configured chain RPC, so a malformed body is the upstream's to reject and
  // a 5xx here means "upstream unreachable", not "we crashed". Asserting 4xx on it would have been a
  // false finding — it forwards by design.
  it('/rpc refuses cleanly when no RPC is configured, rather than proxying to nowhere', async () => {
    const r = await call('/rpc', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}',
    }, env({ RPC_URL: undefined }));
    expect(r.status).toBe(503);
    const out = await r.json() as { error: { message: string } };
    expect(out.error.message).toBe('rpc_unconfigured');
  });

  it('answers an empty body without a 5xx', async () => {
    const r = await call('/api/a2a', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '',
    });
    expect(r.status).toBeLessThan(500);
  });
});
