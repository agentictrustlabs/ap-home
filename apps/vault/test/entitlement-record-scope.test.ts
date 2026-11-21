// The entitlement admin tools and the profile tools read the record scope of the delegation presented.
// `withDelegation` is replaced by a stand-in that hands the handler a verified principal and the record scopes
// under test, so what runs is each route's own handler — the code that decides.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRINCIPAL = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
let scopes: unknown;

vi.mock('@agenticprimitives/mcp-runtime', async (orig) => {
  const real = await orig<typeof import('@agenticprimitives/mcp-runtime')>();
  return {
    ...real,
    withDelegation: (_cfg: unknown, fn: (x: Record<string, unknown>) => unknown) =>
      async (input: { args?: unknown }) => fn({ principal: PRINCIPAL, args: input.args ?? {}, grants: [], recordScopes: scopes }),
    // The A2A→MCP envelope is not what is under test here.
    verifyServiceMac: async () => ({ ok: true }),
  };
});

const db = {
  prepare: () => ({
    bind: () => ({ all: async () => ({ results: [] }), run: async () => ({ success: true }), first: async () => null }),
    all: async () => ({ results: [] }),
  }),
};
const env = { MCP_AUDIENCE: 'https://mcp.example.test/mcp', RPC_URL: 'https://rpc.example.test', CHAIN_ID: '84532', DB: db, A2A_MAC_SECRET: '00'.repeat(32) } as never;

async function tool(name: string, args: Record<string, unknown> = {}) {
  const app = (await import('../src/index.js')).default as { fetch: (r: Request, e: never) => Promise<Response> };
  const r = await app.fetch(new Request(`https://mcp.example.test/tools/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-A2A-Mac': 'm', 'X-A2A-Mac-Nonce': 'n', 'X-A2A-Mac-Timestamp': String(Date.now()), 'X-A2A-Mac-Key-Id': 'k' },
    body: JSON.stringify({ token: 't', args }),
  }), env);
  return (await r.json()) as { ok?: boolean; error?: string };
}

beforeEach(() => { vi.resetModules(); scopes = undefined; });

describe('entitlement admin tools refuse a record-scoped delegation', () => {
  // The shape the delegation verifier surfaces for a VAULT_RECORD_SCOPE caveat (a member's narrow read grant).
  const scoped = [{ server: 'any', resources: ['vault:member.profile'], ops: ['read'] }];
  it.each([
    ['issue_org_entitlement', { subject: OTHER, recordType: 'anything' }],
    ['revoke_org_entitlement', { id: 'urn:ap:entitlement:x' }],
    ['list_org_entitlements', {}],
    ['manage_entitlement_group', { groupId: 'g', op: 'set', members: [OTHER] }],
  ])('%s', async (name, args) => {
    scopes = scoped;
    expect(await tool(name, args)).toMatchObject({ ok: false, error: 'record_scoped_delegation_not_allowed' });
  });

  it('an unscoped delegation (the principal’s own authority) still lists', async () => {
    scopes = undefined;
    expect(await tool('list_org_entitlements')).toMatchObject({ ok: true });
  });
});

describe('profile tools respect the record scope', () => {
  it.each(['get_profile', 'get_pii', 'get_org_sensitive', 'update_profile'])('%s refuses a delegation scoped to another record', async (name) => {
    scopes = [{ server: 'any', resources: ['vault:member.profile'], ops: ['read', 'write'] }];
    expect(await tool(name)).toMatchObject({ ok: false, error: 'record_scope_denied' });
  });
});
