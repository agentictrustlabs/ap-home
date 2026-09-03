// ADR-0040 on the Ask's read path: public data, one direction. These tests are the boundary, not the
// plumbing — what may be sent, what may be read, and that there is no way to write.
import { describe, expect, it, vi } from 'vitest';
import { ASK_DISCOVERY_TOOLS, ASK_DISCOVERY_TOOL_IDS, askDiscoveryInvoker } from '../src/ask-discovery.js';

const ctx = { intent: { goal: 'g' }, step: { toolId: 't', args: {} }, index: 0 } as never;
function fakeDiscovery(handler: (path: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const seen: Array<{ path: string; init?: RequestInit }> = [];
  const env = {
    DISCOVERY_MCP: {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).replace('https://discovery-mcp', '');
        seen.push({ path, ...(init ? { init } : {}) });
        const r = handler(path, init);
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      }),
    },
  };
  return { env, seen };
}

describe('the Ask reads the public directory, and only reads it', () => {
  it('every tool is informational — reading what the chain publishes needs no authority', () => {
    for (const t of ASK_DISCOVERY_TOOLS) expect(t.capability).toBeUndefined();
    expect([...ASK_DISCOVERY_TOOL_IDS].sort()).toEqual(['find_agents', 'get_agent', 'list_agent_facets']);
  });

  it('has no write: every request it can make is a GET', async () => {
    const { env, seen } = fakeDiscovery(() => ({ body: { ok: true, agents: [], types: [] } }));
    const invoke = askDiscoveryInvoker(env as never);
    await invoke('find_agents', { terms: 'outreach' }, ctx);
    await invoke('get_agent', { key: 'outreach.team' }, ctx);
    await invoke('list_agent_facets', {}, ctx);
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s.init?.method ?? 'GET').toBe('GET');
  });

  it('sends the search TERMS the planner chose — never a whole question, never the asker', async () => {
    const { env, seen } = fakeDiscovery(() => ({ body: { ok: true, agents: [{ name: 'outreach.team' }] } }));
    const r = await askDiscoveryInvoker(env as never)('find_agents', { terms: 'outreach greeley', limit: 5 }, ctx);
    expect(seen[0]!.path).toBe('/search?q=outreach%20greeley&limit=5');
    expect(r).toMatchObject({ count: 1 });
    // nothing about the run reaches the KB
    expect(seen[0]!.path).not.toMatch(/0x|asker|session|runRef/);
  });

  it('caps the rows it will ask for, whatever the planner requests', async () => {
    const { env, seen } = fakeDiscovery(() => ({ body: { ok: true, agents: [] } }));
    await askDiscoveryInvoker(env as never)('find_agents', { terms: 'x', limit: 5000 }, ctx);
    expect(seen[0]!.path).toContain('limit=25');
  });

  it('an unreachable or failing directory THROWS — never an empty answer that reads like "there are none"', async () => {
    const down = askDiscoveryInvoker({} as never);
    await expect(down('find_agents', { terms: 'x' }, ctx)).rejects.toThrow(/not reachable/);
    const { env } = fakeDiscovery(() => ({ status: 502, body: { ok: false, error: 'graph 401' } }));
    await expect(askDiscoveryInvoker(env as never)('find_agents', { terms: 'x' }, ctx)).rejects.toThrow(/502.*graph 401/);
  });

  it('refuses a tool that is not one of its reads', async () => {
    const { env } = fakeDiscovery(() => ({ body: { ok: true } }));
    await expect(askDiscoveryInvoker(env as never)('set_vault_record', {}, ctx)).rejects.toThrow(/not a discovery read/);
  });
});
