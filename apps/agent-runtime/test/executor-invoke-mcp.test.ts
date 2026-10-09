import { describe, it, expect } from 'vitest';
import { executorInvokeInvoker, readExecutors, type McpToolsCallInvokeV1 } from '../src/executor-invoke.js';

const PRINCIPAL = '0x4f562955b31451d671d64c5d3f2f2aa2412df39b' as const;
const INVOKE: McpToolsCallInvokeV1 = { transport: 'mcp.tools-call', executor: 'gc-people-groups', intent: 'count_people_groups', args: { arguments: ['countryCode', 'religion', 'affinityBloc'] } };
const EXECUTORS = readExecutors(JSON.stringify({ 'global-church': { url: 'https://a2a.example', client: 'gc-engage' }, 'gc-people-groups': { url: 'https://demo-gc-pg.example/mcp', kind: 'mcp' }, 'bad-mcp': { url: 'http://plain.example/mcp', kind: 'mcp' } }));
const fakeFetch = (result: unknown, status = 200) => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: { method: string; params: { name: string; arguments: Record<string, unknown> } } }> = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status }); }) as unknown as typeof fetch;
  return { f, calls };
};
const session = async () => { throw new Error('a session must never be minted for an MCP read'); };

describe('spec 426 — the mcp.tools-call transport: a named stateless MCP server, one tools/call, no session', () => {
  it('reads the operator map: an mcp entry needs only an https url; an a2a entry still needs its client', () => {
    expect(EXECUTORS['gc-people-groups']).toEqual({ url: 'https://demo-gc-pg.example/mcp', client: '', kind: 'mcp' });
    expect(EXECUTORS['global-church']).toEqual({ url: 'https://a2a.example', client: 'gc-engage' });
    expect(EXECUTORS['bad-mcp']).toBeUndefined();
  });
  it('forwards ONLY the named args as the tool\'s arguments, mints no session, and returns the server\'s rows as evidence', async () => {
    const { f, calls } = fakeFetch({ structuredContent: { rows: [{ measure: 'jp-least-reached', peopleInCountry: 2033, distinctPeoples: 2033 }], filters: { countryCode: 'IN', religion: 'all', affinityBloc: 'all' }, profile: 'ap-people-group-catalog/v1' } });
    const out = await executorInvokeInvoker({ executors: EXECUTORS, session, fetch: f }, INVOKE, PRINCIPAL)('peoplegroup.count', { countryCode: 'IN', question: 'how many unreached people groups are in India', holder: 'x' }, {} as never) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://demo-gc-pg.example/mcp');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ method: 'tools/call', params: { name: 'count_people_groups', arguments: { countryCode: 'IN' } } });
    expect(out).toMatchObject({ count: 1, rows: [{ measure: 'jp-least-reached', peopleInCountry: 2033 }], filters: { countryCode: 'IN' }, invoked: { executor: 'gc-people-groups', intent: 'count_people_groups', transport: 'mcp.tools-call' } });
    expect(String(out.interpretation)).toMatch(/invoked gc-people-groups · count_people_groups/);
  });
  it('refuses rather than guesses: no mcp executor configured, an a2a executor named by an mcp invoke, an outage, a non-JSON body, a tool error', async () => {
    const inv = executorInvokeInvoker({ executors: EXECUTORS, session, fetch: fakeFetch({}).f }, { ...INVOKE, executor: 'nope' }, PRINCIPAL);
    expect(await inv('peoplegroup.count', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('no MCP executor') });
    const crossed = executorInvokeInvoker({ executors: EXECUTORS, session, fetch: fakeFetch({}).f }, { ...INVOKE, executor: 'global-church' }, PRINCIPAL);
    expect(await crossed('peoplegroup.count', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('no MCP executor') });
    const reverse = executorInvokeInvoker({ executors: EXECUTORS, session, fetch: fakeFetch({}).f }, { transport: 'a2a.message-send', executor: 'gc-people-groups', intent: 'x', args: { goal: 'goal' } }, PRINCIPAL);
    expect(await reverse('x', { goal: 'g' }, {} as never)).toMatchObject({ refused: expect.stringContaining('no executor is configured') });
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await executorInvokeInvoker({ executors: EXECUTORS, session, fetch: down }, INVOKE, PRINCIPAL)('peoplegroup.count', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('did not answer') });
    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
    expect(await executorInvokeInvoker({ executors: EXECUTORS, session, fetch: html }, INVOKE, PRINCIPAL)('peoplegroup.count', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('502') });
    const { f } = fakeFetch({ isError: true, structuredContent: { error: 'countryCode must be a two-letter FIPS 10-4 code (e.g. "IN") or "ALL" — got "India"' } });
    expect(await executorInvokeInvoker({ executors: EXECUTORS, session, fetch: f }, INVOKE, PRINCIPAL)('peoplegroup.count', { countryCode: 'India' }, {} as never)).toMatchObject({ refused: expect.stringContaining('FIPS') });
    expect(await executorInvokeInvoker({ executors: EXECUTORS, session, fetch: f }, INVOKE, undefined)('peoplegroup.count', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('no principal') });
  });
});
