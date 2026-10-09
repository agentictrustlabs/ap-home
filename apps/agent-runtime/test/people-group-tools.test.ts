import { describe, it, expect } from 'vitest';
import { PEOPLE_GROUP_TOOLS, PEOPLE_GROUP_COUNT_CAPABILITY, PEOPLE_GROUP_MEASURES_CAPABILITY, PEOPLE_GROUP_MCP_TOOL_NAMES, isPeopleGroupTool, peopleGroupInvoker, servesProfile, toolsServedAt } from '../src/people-group-tools.js';
import { CATALOG_MCP_TOOL_NAMES, CATALOG_TOOLS, isCatalogTool } from '../src/catalog-tools.js';

const NAME = 'people-groups.svc'; const ENDPOINT = 'https://demo-gc-pg.example/mcp';
const fakeFetch = (result: unknown, status = 200) => {
  const calls: Array<{ url: string; body: { method: string; params?: { name: string; arguments: unknown } } }> = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status }); }) as unknown as typeof fetch;
  return { f, calls };
};
const ROWS = [
  { measure: 'jp-entries', peopleInCountry: 2272, distinctPeoples: 2272 }, { measure: 'jp-least-reached', peopleInCountry: 2035, distinctPeoples: 2035 },
  { measure: 'jp-frontier', peopleInCountry: 1250, distinctPeoples: 1250 }, { measure: 'jp-frontier-no-engagement-report', peopleInCountry: 1100, distinctPeoples: 1100 },
  { measure: 'imb-entries', peopleInCountry: 2100, distinctPeoples: 2100 }, { measure: 'base-list', peopleInCountry: 2500, distinctPeoples: 2500 },
];

describe('the agent\'s own people-group catalog as a step (ap-people-group-catalog/v1)', () => {
  it('is its own profile: its capability ids and MCP tool names are disjoint from the content catalog\'s', () => {
    expect(PEOPLE_GROUP_TOOLS.map((t) => t.id)).toEqual([PEOPLE_GROUP_COUNT_CAPABILITY, PEOPLE_GROUP_MEASURES_CAPABILITY]);
    expect(PEOPLE_GROUP_TOOLS.map((t) => t.id).every(isPeopleGroupTool)).toBe(true);
    expect(PEOPLE_GROUP_TOOLS.map((t) => t.id).some(isCatalogTool)).toBe(false);
    expect(CATALOG_TOOLS.map((t) => t.id).some(isPeopleGroupTool)).toBe(false);
    expect([...PEOPLE_GROUP_MCP_TOOL_NAMES]).toEqual(['count_people_groups', 'list_measures']);
    expect(PEOPLE_GROUP_MCP_TOOL_NAMES.some((n) => CATALOG_MCP_TOOL_NAMES.includes(n))).toBe(false);
    for (const t of PEOPLE_GROUP_TOOLS) expect(t.establishes).toBe('lookup');
  });
  it('tells the profiles apart by what the endpoint SERVES: tools/list names decide; unknown (unreadable) serves neither', async () => {
    const pg = fakeFetch({ tools: [{ name: 'count_people_groups' }, { name: 'list_measures' }] });
    const served = await toolsServedAt(ENDPOINT, { fetch: pg.f });
    expect(pg.calls[0]!.body.method).toBe('tools/list');
    expect(served).toEqual(['count_people_groups', 'list_measures']);
    expect(servesProfile(served, PEOPLE_GROUP_MCP_TOOL_NAMES)).toBe(true);
    expect(servesProfile(served, CATALOG_MCP_TOOL_NAMES)).toBe(false);
    const content = await toolsServedAt(ENDPOINT, { fetch: fakeFetch({ tools: [{ name: 'search_resources' }, { name: 'list_topics' }, { name: 'get_resource' }] }).f });
    expect(servesProfile(content, CATALOG_MCP_TOOL_NAMES)).toBe(true);
    expect(servesProfile(content, PEOPLE_GROUP_MCP_TOOL_NAMES)).toBe(false);
    expect(await toolsServedAt(ENDPOINT, { fetch: fakeFetch('<html>', 502).f })).toBeNull();
    expect(await toolsServedAt(ENDPOINT, { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch })).toBeNull();
    expect(await toolsServedAt(ENDPOINT, { fetch: fakeFetch({ nope: true }).f })).toBeNull();
    expect(servesProfile(null, PEOPLE_GROUP_MCP_TOOL_NAMES)).toBe(false);
    expect(servesProfile([], PEOPLE_GROUP_MCP_TOOL_NAMES)).toBe(false);
  });
  it('a count is ONE MCP tools/call at the bound endpoint; India\'s jp-least-reached row is named in the interpretation with its source and unit', async () => {
    const { f, calls } = fakeFetch({ structuredContent: { rows: ROWS, filters: { countryCode: 'IN', religion: 'all', affinityBloc: 'all' }, measures: [{ measure: 'jp-entries' }], units: { peopleInCountry: 'entries' }, source: { gateway: 'https://api.global.church/v0/sparql', query: 'people-group-counts-filtered.rq' }, profile: 'ap-people-group-catalog/v1' } });
    const out = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })(PEOPLE_GROUP_COUNT_CAPABILITY, { countryCode: 'IN' }, {} as never) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.body.params).toEqual({ name: 'count_people_groups', arguments: { countryCode: 'IN' } });
    expect(out).toMatchObject({ count: 6, filters: { countryCode: 'IN' }, gateway: { query: 'people-group-counts-filtered.rq' }, source: { agent: NAME, catalog: ENDPOINT, profile: 'ap-people-group-catalog/v1', tool: 'count_people_groups' } });
    expect((out.rows as typeof ROWS).find((r) => r.measure === 'jp-least-reached')).toEqual({ measure: 'jp-least-reached', peopleInCountry: 2035, distinctPeoples: 2035 });
    expect(String(out.interpretation)).toMatch(/country IN \(FIPS\)/);
    expect(String(out.interpretation)).toMatch(/jp-least-reached\): 2035 people-in-country entries, 2035 distinct peoples/);
    expect(String(out.interpretation)).toMatch(/invent nothing/);
    const legend = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: fakeFetch({ structuredContent: { measures: [{ measure: 'jp-entries' }], units: {} } }).f })(PEOPLE_GROUP_MEASURES_CAPABILITY, {}, {} as never) as Record<string, unknown>;
    expect(legend).toMatchObject({ measures: [{ measure: 'jp-entries' }], source: { tool: 'list_measures' }, interpretation: expect.stringContaining('legend') });
  });
  it('no binding refuses; an outage, a non-JSON answer and a catalog error (no key, a bad FIPS code) are each said as such — no number is guessed', async () => {
    expect(await peopleGroupInvoker(null)(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ refused: expect.stringContaining('atl:mcpEndpoint') });
    const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: down })(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('did not answer') });
    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: html })(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('502') });
    const { f } = fakeFetch({ isError: true, structuredContent: { error: 'countryCode must be a two-letter FIPS 10-4 code (e.g. "IN") or "ALL" — got "India"', filters: { countryCode: 'INDIA' } } });
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })(PEOPLE_GROUP_COUNT_CAPABILITY, { countryCode: 'India' }, {} as never)).toMatchObject({ error: expect.stringContaining('FIPS'), detail: { filters: { countryCode: 'INDIA' } }, interpretation: expect.stringContaining('do not supply a number') });
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })('catalog.resource.search', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('not a people-group read') });
  });
});
