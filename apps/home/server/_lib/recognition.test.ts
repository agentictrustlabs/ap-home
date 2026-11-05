// Spec 445 §3.2 — the recognition cookie: what it looks like, who gets one, and that it cannot be skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = { value: 'https://www.faithnet.me' };
vi.mock('./server-broker', () => ({ resolveOrigin: () => ORIGIN.value }));
vi.mock('../../src/lib/domain', () => ({ CONNECT_DOMAIN: 'faithnet.me' }));
vi.mock('../../src/lib/chain', () => ({ DEPLOYMENT_EPOCH: 'epoch-1' }));

import { clearRecognition, readRecognition, withRecognition } from './recognition';

let store: Map<string, string>;
let ttls: Map<string, number | undefined>;
const kv = {
  async get(k: string) { return store.get(k) ?? null; },
  async put(k: string, v: string, o?: { expirationTtl?: number }) { store.set(k, v); ttls.set(k, o?.expirationTtl); },
  async delete(k: string) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const env = { AUTH_CODES: kv } as never;
const req = (headers: Record<string, string> = {}) => new Request('https://www.faithnet.me/connect/passkey', { method: 'POST', headers });
const proved = { sub: 'eip155:1:0xabc', principal: { kind: 'passkey' }, assurance: 'onchain-confirmed', ttlSeconds: 3600 };
const cookieOf = (r: Response) => r.headers.get('set-cookie') ?? '';
const asCookieHeader = (r: Response) => ({ cookie: cookieOf(r).split(';')[0]! });

beforeEach(() => { store = new Map(); ttls = new Map(); ORIGIN.value = 'https://www.faithnet.me'; });

describe('what the server sets', () => {
  it('is HttpOnly, Strict, Secure, on the parent domain, for as long as the session', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    const c = cookieOf(r);
    expect(c).toMatch(/^__Secure-ap_sid=[\w-]{40,};/);
    for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Domain=.faithnet.me', 'Max-Age=3600', 'Path=/']) expect(c).toContain(part);
    expect([...ttls.values()]).toEqual([3600]);
  });
  it('is host-only and not Secure on a plain-http dev host', async () => {
    ORIGIN.value = 'http://localhost:5373';
    const c = cookieOf(await withRecognition(new Response('{}'), { request: new Request('http://localhost:5373/x', { method: 'POST' }), env }, proved));
    expect(c).toMatch(/^ap_sid=/);
    expect(c).toContain('HttpOnly');
    expect(c).not.toContain('Secure');
    expect(c).not.toContain('Domain=');
  });
  it('holds an opaque id: the store is keyed by its hash and the value says nothing', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    const sid = cookieOf(r).split(';')[0]!.split('=')[1]!;
    expect(sid.split('.')).toHaveLength(1); // not a JWT
    expect([...store.keys()].some((k) => k.includes(sid))).toBe(false);
    expect([...store.values()].join('')).not.toContain(sid);
  });
  it('caps a very long session, so a demo account is not recognized for ten years', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, { ...proved, ttlSeconds: 315_360_000 });
    expect(cookieOf(r)).toContain(`Max-Age=${12 * 3600}`);
  });
  it('leaves the response as it was', async () => {
    const r = await withRecognition(new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }), { request: req(), env }, proved);
    expect(await r.json()).toEqual({ a: 1 });
    expect(r.headers.get('content-type')).toBe('application/json');
    const redirect = await withRecognition(new Response(null, { status: 302, headers: { location: 'https://x.test/' } }), { request: req(), env }, proved);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://x.test/');
    expect(cookieOf(redirect)).toContain('__Secure-ap_sid=');
  });
});

describe('who does not get one', () => {
  it('a cross-origin caller', async () => {
    const r = await withRecognition(new Response('{}'), { request: req({ origin: 'https://app.test' }), env }, proved);
    expect(cookieOf(r)).toBe('');
    expect(store.size).toBe(0);
  });
  it('a failed response', async () => {
    const r = await withRecognition(new Response('{}', { status: 401 }), { request: req(), env }, proved);
    expect(cookieOf(r)).toBe('');
  });
  it('a weaker credential, which also ends the one that was there', async () => {
    const first = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    expect(store.size).toBe(1);
    const r = await withRecognition(new Response('{}'), { request: req(asCookieHeader(first)), env }, { ...proved, assurance: 'asserted' });
    expect(store.size).toBe(0);
    expect(cookieOf(r)).toContain('Max-Age=0');
  });
});

describe('reading and ending it', () => {
  it('reads back who was proved', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    expect(await readRecognition(req(asCookieHeader(r)), kv)).toMatchObject({ sub: proved.sub, cred: 'passkey', epoch: 'epoch-1' });
  });
  it('answers null with no cookie, or a made-up one', async () => {
    expect(await readRecognition(req(), kv)).toBeNull();
    expect(await readRecognition(req({ cookie: '__Secure-ap_sid=nonsense' }), kv)).toBeNull();
  });
  it('does not take a session token presented as the cookie', async () => {
    expect(await readRecognition(req({ cookie: '__Secure-ap_sid=eyJhbGciOiJFUzI1NiJ9.e30.sig', authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.e30.sig' }), kv)).toBeNull();
  });
  it('refuses one from before a full-reset redeploy', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    const key = [...store.keys()][0]!;
    store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)!), epoch: 'epoch-0' }));
    expect(await readRecognition(req(asCookieHeader(r)), kv)).toBeNull();
  });
  it('a new credential replaces the old one rather than leaving it live', async () => {
    const first = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    await withRecognition(new Response('{}'), { request: req(asCookieHeader(first)), env }, proved);
    expect(store.size).toBe(1);
    expect(await readRecognition(req(asCookieHeader(first)), kv)).toBeNull();
  });
  it('sign-out ends it on the server, so a copy of the cookie is worth nothing', async () => {
    const r = await withRecognition(new Response('{}'), { request: req(), env }, proved);
    const out = await clearRecognition(new Response('{}'), { request: req(asCookieHeader(r)), env });
    expect(cookieOf(out)).toContain('Max-Age=0');
    expect(cookieOf(out)).toContain('Domain=.faithnet.me');
    expect(await readRecognition(req(asCookieHeader(r)), kv)).toBeNull();
  });
  it('a store that cannot write costs a later sheet, not this sign-in', async () => {
    const broken = { ...kv, put: async () => { throw new Error('down'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await withRecognition(new Response('{"ok":1}'), { request: req(), env: { AUTH_CODES: broken } as never }, proved);
    expect(r.status).toBe(200);
    expect(cookieOf(r)).toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('every place a Home session is minted', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []; });
  const root = join(__dirname, '..');
  it('answers through withRecognition, and nothing else does', () => {
    const all = files(root);
    const minters = all.filter((f) => /\bmintAgentSession\s*\(/.test(readFileSync(f, 'utf8')));
    expect(minters.length).toBeGreaterThanOrEqual(10);
    for (const f of minters) expect(readFileSync(f, 'utf8'), f).toMatch(/withRecognition\(/);
    const callers = all.filter((f) => !f.endsWith('recognition.ts') && /\bwithRecognition\(/.test(readFileSync(f, 'utf8')));
    expect(callers.sort()).toEqual(minters.sort()); // never minted from a token: only where a credential was just proved
  });
  it('the decision endpoint reads the cookie and never a bearer', () => {
    const src = readFileSync(join(root, 'oidc', 'remembered.ts'), 'utf8');
    expect(src).toContain('readRecognition(request');
    expect(src).not.toMatch(/headers\.get\('authorization'\)|verifyAgentSession/);
  });
});
