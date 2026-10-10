import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, mintAgentSession } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { onAdminAccounts, onAdminAzureCosts, onAdminMe } from './admin';

// The Admin tab's routes: the server decides who is an admin (HOME_ADMINS), whatever the menu shows.
const ADMIN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ORG = '0x3333333333333333333333333333333333333333';

function makeKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    async list(o?: { prefix?: string }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(o?.prefix ?? '')).map((name) => ({ name })), list_complete: true };
    },
    _map: m,
  };
}

let env: any;
const base = 'https://home.test/connect/admin';

async function mint(sa: string): Promise<string> {
  const { getServer } = await import('../_lib/server-broker');
  const { signer } = await getServer(env);
  return mintAgentSession(
    {
      sub: `eip155:28190:${sa}` as any,
      principal: { kind: 'siwe-eoa', id: sa, assurance: 'onchain-confirmed', role: 'custody-grade' } as any,
      assurance: 'onchain-confirmed',
      aud: 'demo-sso',
      iss: resolveOrigin(new Request(base), env),
      ttlSeconds: 3600,
    },
    signer,
  );
}

const get = (path: string, token?: string) =>
  new Request(`${base}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  const kp = await generateBrokerKeypair('ES256');
  env = {
    AUTH_CODES: makeKV(),
    BROKER_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)),
    BROKER_KID: 'test-broker',
    DEMO_SSO_AUD: 'demo-sso',
    HOME_ADMINS: ADMIN,
  };
  const kv = env.AUTH_CODES._map as Map<string, string>;
  kv.set('facet:email:h1', JSON.stringify([{ agent: `eip155:28190:${ADMIN}`, assurance: 'asserted', ref: 'kv-email' }]));
  kv.set('facet:email:h2', JSON.stringify([{ agent: `eip155:28190:${OTHER}`, assurance: 'asserted', ref: 'kv-email' }]));
  kv.set(`related:${ADMIN}:${ORG}`, JSON.stringify({ kind: 'org', createdAt: Date.now() }));
});

describe('the Admin routes', () => {
  it('refuse without a session (401) and for anyone not on HOME_ADMINS (403)', async () => {
    expect((await onAdminAccounts({ request: get('accounts'), env })).status).toBe(401);
    expect((await onAdminAccounts({ request: get('accounts', await mint(OTHER)), env })).status).toBe(403);
    expect((await onAdminAzureCosts({ request: get('azure-costs', await mint(OTHER)), env })).status).toBe(403);
  });

  it('an empty admin list is nobody', async () => {
    const res = await onAdminAccounts({ request: get('accounts', await mint(ADMIN)), env: { ...env, HOME_ADMINS: '' } });
    expect(res.status).toBe(403);
  });

  it('/me says whether to show the row', async () => {
    expect(await (await onAdminMe({ request: get('me', await mint(ADMIN)), env })).json()).toEqual({ admin: true });
    expect(await (await onAdminMe({ request: get('me', await mint(OTHER)), env })).json()).toEqual({ admin: false });
    expect(await (await onAdminMe({ request: get('me'), env })).json()).toEqual({ admin: false });
  });

  it('an admin gets the counts — numbers only, no addresses — and today\'s snapshot is kept', async () => {
    const res = await onAdminAccounts({ request: get('accounts?refresh=1', await mint(ADMIN)), env });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ADMIN.slice(2));
    const body = JSON.parse(text);
    expect(body.accounts).toBe(2);
    expect(body.organizations).toBe(1);
    expect(body.new7d).toBeNull();
    expect(body.history).toHaveLength(1);
    expect(env.AUTH_CODES._map.has('admin-snap:accounts')).toBe(true);
  });

  it('Azure not set up is said plainly, not shown as $0', async () => {
    const body = await (await onAdminAzureCosts({ request: get('azure-costs', await mint(ADMIN)), env })).json();
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/not set up/);
  });
});
