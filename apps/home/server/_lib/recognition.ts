// THE RECOGNITION COOKIE (spec 445 §3.2): did this browser prove a credential as this person, and when.
//
// Set by the server and unreadable by script. It is the proof /oidc/remembered takes, in place of the session token any
// script on the page can read and replay from another machine.
//
// THE VALUE IS OPAQUE: a random id whose hash keys a server-side record. So it cannot be mistaken for a bearer anywhere
// (it is not a JWT, and no verifier will take it), it says nothing to whoever holds it, a leak of the store yields no
// cookie, and sign-out ends it at once on the server rather than asking the browser to forget it.
//
// IT IS NEVER MINTED FROM A TOKEN. `withRecognition` is called only where a credential was just proved, and no endpoint
// turns a session token into this cookie. If one did, a stolen token would buy the cookie and the cookie would prove
// nothing. A session that exists when this ships gets its cookie at the person's next credential ceremony.
import { CONNECT_DOMAIN } from '../../src/lib/domain';
import { DEPLOYMENT_EPOCH } from '../../src/lib/chain';
import { resolveOrigin, type Env, type KVNamespace } from './server-broker';

const SECURE_NAME = '__Secure-ap_sid';
const PLAIN_NAME = 'ap_sid';
const KEY = (hash: string): string => `recognition:${hash}`;

/** Spec 445 §3.3, lifetime A: as long as the session minted beside it. Capped, so a demo account's ten-year session is
 *  not ten years of recognition. Lifetime B (30 days) is an owner decision and is not this. */
const MAX_TTL_SECONDS = 12 * 3600;

export interface Recognition {
  sub: string;
  cred: string;
  /** When the credential was proved, in seconds. */
  auth_time: number;
  epoch?: string;
}

type Ctx = { request: Request; env: Pick<Env, 'AUTH_CODES'> & Partial<Env> };
type Proved = { sub: string; principal: { kind: string }; assurance: string; ttlSeconds: number };

async function hashOf(sid: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(sid));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newSid(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function attributes(request: Request, env: Ctx['env'], maxAge: number): { name: string; attrs: string } {
  const origin = new URL(resolveOrigin(request, env as Env));
  const secure = origin.protocol === 'https:';
  const host = origin.hostname.toLowerCase();
  const onParent = secure && (host === CONNECT_DOMAIN || host.endsWith(`.${CONNECT_DOMAIN}`));
  // The parent domain because a passkey person signs in at <label>.<domain> and is recognized at www. Strict because
  // the only reader is a same-origin POST from the Home's own page.
  const attrs = [`Max-Age=${maxAge}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : []), ...(onParent ? [`Domain=.${CONNECT_DOMAIN}`] : [])].join('; ');
  return { name: secure ? SECURE_NAME : PLAIN_NAME, attrs };
}

function readSid(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === SECURE_NAME || k === PLAIN_NAME) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function withCookie(res: Response, cookie: string): Response {
  const out = new Response(res.body, res);
  out.headers.append('set-cookie', cookie);
  return out;
}

/** The record this request's cookie names, or null: no cookie, an ended one, or one from before a full-reset redeploy. */
export async function readRecognition(request: Request, kv: KVNamespace): Promise<Recognition | null> {
  const sid = readSid(request);
  if (!sid) return null;
  const raw = await kv.get(KEY(await hashOf(sid)));
  if (!raw) return null;
  const rec = JSON.parse(raw) as Recognition;
  if (DEPLOYMENT_EPOCH && rec.epoch !== DEPLOYMENT_EPOCH) return null;
  return rec;
}

/** End recognition: the server's record first, then the browser's cookie. */
export async function clearRecognition(res: Response, { request, env }: Ctx): Promise<Response> {
  const sid = readSid(request);
  if (sid) await env.AUTH_CODES.delete(KEY(await hashOf(sid)));
  const { name, attrs } = attributes(request, env, 0);
  return withCookie(res, `${name}=; ${attrs}`);
}

/**
 * Every handler that mints a Home session answers through this: `return withRecognition(json(...), ctx, proved)`.
 * (`recognition.test.ts` fails when a handler mints one and does not.)
 *
 *   A cross-origin caller (a relying app driving SIWE) gets no cookie: the browser would drop it, and that app's session
 *   is not this Home's. A weaker credential (`asserted`, login-grade) ends whatever recognition was there, because the
 *   browser now belongs to whoever just signed in, and it did not prove enough to set a new one.
 *
 * Best-effort and said: a store that cannot write costs the person a sheet at their next sign-in, never this sign-in.
 */
export async function withRecognition(res: Response, ctx: Ctx, proved: Proved): Promise<Response> {
  const { request, env } = ctx;
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== resolveOrigin(request, env as Env)) return res;
    if (!res.ok && res.status !== 302) return res;
    if (proved.assurance !== 'onchain-confirmed') return await clearRecognition(res, ctx);
    const ttl = Math.min(proved.ttlSeconds, MAX_TTL_SECONDS);
    const sid = newSid();
    const rec: Recognition = { sub: proved.sub, cred: proved.principal.kind, auth_time: Math.floor(Date.now() / 1000), ...(DEPLOYMENT_EPOCH ? { epoch: DEPLOYMENT_EPOCH } : {}) };
    await env.AUTH_CODES.put(KEY(await hashOf(sid)), JSON.stringify(rec), { expirationTtl: ttl });
    const old = readSid(request);
    if (old) await env.AUTH_CODES.delete(KEY(await hashOf(old)));
    const { name, attrs } = attributes(request, env, ttl);
    return withCookie(res, `${name}=${sid}; ${attrs}`);
  } catch (e) {
    console.warn('[recognition] not set; the next sign-in shows the sheet:', e instanceof Error ? e.message : String(e));
    return res;
  }
}
