// THE ESTATE'S SITE. One Worker, no key, no Durable Object, no database. It serves the estate's page, reads the
// estate's heartbeat with a token the estate gave it, and RELAYS a signed-in steward's calls to the estate's own
// runtime. It decides nothing: whether a person may cancel a run or set a budget is the runtime's answer to the
// session they hold, exactly as at the Home — this Worker adds no authority and takes none.
import { fmtAgo, isStale, parseHeartbeat, tilesOf, type Heartbeat } from './model.js';
import { page } from './html.js';

export interface Env {
  ASSETS: Fetcher;
  ESTATE_ID: string;
  /** The estate's name on chain, e.g. `faithnet.estate`. */
  ESTATE_NAME: string;
  HOME_ORIGIN: string;
  A2A_ORIGIN: string;
  PUBLIC_ORIGIN: string;
  /** The workspace agent that answers this estate's Ask, by name and by card. */
  ASK_NAME?: string;
  ASK_CARD_URL?: string;
  /** The runtime's `TOWN_HEARTBEAT_TOKEN`. Unset ⇒ the page says it reads no heartbeat (never zeros). */
  ESTATE_HEARTBEAT_TOKEN?: string;
}

/** The harness reads a steward may relay. Anything else is a 404 here, not a pass-through. */
const RELAYED = new Set(['runs', 'cancel', 'budget']);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

type HeartbeatRead = { ok: true; heartbeat: Heartbeat } | { ok: false; status: number; error: string };

async function readHeartbeat(env: Env, fetchImpl: typeof fetch = fetch): Promise<HeartbeatRead> {
  if (!env.ESTATE_HEARTBEAT_TOKEN) return { ok: false, status: 503, error: 'this site holds no heartbeat token (ESTATE_HEARTBEAT_TOKEN unset)' };
  try {
    const r = await fetchImpl(`${env.A2A_ORIGIN}/ops/heartbeat`, { headers: { authorization: `Bearer ${env.ESTATE_HEARTBEAT_TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, status: 502, error: `the estate's runtime refused the heartbeat read (${r.status})` };
    const heartbeat = parseHeartbeat(await r.json().catch(() => null));
    return heartbeat ? { ok: true, heartbeat } : { ok: false, status: 502, error: 'the estate answered, but not with a heartbeat this page can read' };
  } catch (e) { return { ok: false, status: 502, error: `the estate's runtime could not be reached: ${(e as Error).message}` }; }
}

/** The runtime's CSRF is a double-submit token bound to the caller's ORIGIN, which must be one of the estate's
 *  allowed origins (the estate declaration's `extraOrigins`). Mint one as this site and send it both ways. */
async function relay(env: Env, op: string, body: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const c = await fetchImpl(`${env.A2A_ORIGIN}/auth/csrf`, { headers: { origin: env.PUBLIC_ORIGIN }, signal: AbortSignal.timeout(8000) });
  const t = (await c.json().catch(() => ({}))) as { token?: string };
  if (!c.ok || !t.token) return json({ ok: false, error: `the runtime would not issue a CSRF token to ${env.PUBLIC_ORIGIN} (${c.status}) — is this origin in the estate's ALLOWED_ORIGINS?` }, 502);
  const r = await fetchImpl(`${env.A2A_ORIGIN}/harness/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.PUBLIC_ORIGIN, 'x-csrf-token': t.token, cookie: `agentic-csrf=${t.token}` },
    body, signal: AbortSignal.timeout(30_000),
  });
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/api/estate' && req.method === 'GET') {
      return json({ id: env.ESTATE_ID, name: env.ESTATE_NAME, home: env.HOME_ORIGIN, a2a: env.A2A_ORIGIN, ask: env.ASK_NAME ? { name: env.ASK_NAME, card: env.ASK_CARD_URL ?? null } : null });
    }
    if (path === '/api/heartbeat' && req.method === 'GET') {
      const r = await readHeartbeat(env);
      if (!r.ok) return json({ ok: false, error: r.error }, r.status);
      const now = Date.now();
      return json({ ok: true, at: r.heartbeat.at, ago: fmtAgo(r.heartbeat.at, now), stale: isStale(r.heartbeat, now), generation: r.heartbeat.generation, tiles: tilesOf(r.heartbeat) }, 200, { 'cache-control': 'public, max-age=30' });
    }
    const m = /^\/api\/manage\/([a-z]+)$/.exec(path);
    if (m && req.method === 'POST') {
      if (!RELAYED.has(m[1]!)) return json({ ok: false, error: 'not a call this site relays' }, 404);
      // Same-site only: a page on another origin must not be able to drive a steward's session through here.
      if (req.headers.get('origin') !== env.PUBLIC_ORIGIN) return json({ ok: false, error: 'this relay answers its own page only' }, 403);
      const body = await req.text();
      if (body.length > 8000) return json({ ok: false, error: 'too large' }, 413);
      return relay(env, m[1]!, body);
    }
    if (path === '/' || path === '/connected' || path === '/waiting') {
      return new Response(page({ id: env.ESTATE_ID, name: env.ESTATE_NAME, home: env.HOME_ORIGIN, view: path === '/waiting' ? 'waiting' : 'overview' }), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(req);
  },
};

export { readHeartbeat, relay };
