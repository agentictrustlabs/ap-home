import { describe, it, expect } from 'vitest';
import { PEOPLE_GROUP_TOOLS, PEOPLE_GROUP_COUNT_CAPABILITY, PEOPLE_GROUP_MEASURES_CAPABILITY, PEOPLE_GROUP_MCP_TOOL_NAMES, isPeopleGroupTool, peopleGroupCapabilities, peopleGroupInvoker, peopleGroupToolsFrom, mcpToolFor, servesProfile, toolsServedAt } from '../src/people-group-tools.js';
import { CATALOG_MCP_TOOL_NAMES, CATALOG_TOOLS, isCatalogTool } from '../src/catalog-tools.js';
import { withRecordMountedSkills } from '../src/host-context.js';

const NAME = 'people-groups.svc'; const ENDPOINT = 'https://demo-gc-pg.example/mcp';
const fakeFetch = (result: unknown, status = 200) => {
  const calls: Array<{ url: string; body: { method: string; params?: { name: string; arguments: unknown } } }> = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status }); }) as unknown as typeof fetch;
  return { f, calls };
};
/** What the catalog serves, as `tools/list` describes it — the two pinned reads this harness has always had. */
const SERVED = [
  { name: 'count_people_groups', description: 'counts', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_measures', description: 'the legend', inputSchema: { type: 'object', properties: {} } },
];
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
    // DESCRIPTORS, not names: the description, the schema and `_meta.capability` are what the planner and
    // the invoker are built from. `servesProfile` takes either shape.
    expect(served!.map((t) => t.name)).toEqual(['count_people_groups', 'list_measures']);
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
    const out = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: f })(PEOPLE_GROUP_COUNT_CAPABILITY, { countryCode: 'IN' }, {} as never) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.body.params).toEqual({ name: 'count_people_groups', arguments: { countryCode: 'IN' } });
    expect(out).toMatchObject({ count: 6, filters: { countryCode: 'IN' }, gateway: { query: 'people-group-counts-filtered.rq' }, source: { agent: NAME, catalog: ENDPOINT, profile: 'ap-people-group-catalog/v1', tool: 'count_people_groups' } });
    expect((out.rows as typeof ROWS).find((r) => r.measure === 'jp-least-reached')).toEqual({ measure: 'jp-least-reached', peopleInCountry: 2035, distinctPeoples: 2035 });
    expect(String(out.interpretation)).toMatch(/country IN \(FIPS\)/);
    expect(String(out.interpretation)).toMatch(/jp-least-reached\): 2035 people-in-country entries, 2035 distinct peoples/);
    expect(String(out.interpretation)).toMatch(/invent nothing/);
    const legend = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: fakeFetch({ structuredContent: { measures: [{ measure: 'jp-entries' }], units: {} } }).f })(PEOPLE_GROUP_MEASURES_CAPABILITY, {}, {} as never) as Record<string, unknown>;
    expect(legend).toMatchObject({ measures: [{ measure: 'jp-entries' }], source: { tool: 'list_measures' }, interpretation: expect.stringContaining('legend') });
  });
  it('no binding refuses; an outage, a non-JSON answer and a catalog error (no key, a bad FIPS code) are each said as such — no number is guessed', async () => {
    expect(await peopleGroupInvoker(null, SERVED)(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ refused: expect.stringContaining('atl:mcpEndpoint') });
    const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: down })(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('did not answer') });
    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: html })(PEOPLE_GROUP_COUNT_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('502') });
    const { f } = fakeFetch({ isError: true, structuredContent: { error: 'countryCode must be a two-letter FIPS 10-4 code (e.g. "IN") or "ALL" — got "India"', filters: { countryCode: 'INDIA' } } });
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: f })(PEOPLE_GROUP_COUNT_CAPABILITY, { countryCode: 'India' }, {} as never)).toMatchObject({ error: expect.stringContaining('FIPS'), detail: { filters: { countryCode: 'INDIA' } }, interpretation: expect.stringContaining('do not supply a number') });
    expect(await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, SERVED, { fetch: f })('catalog.resource.search', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('does not serve') });
  });
});

describe('the catalog describes its own reads — the harness holds no list of them', () => {
  const meta = (capability: string, unit?: string) => ({ capability, ...(unit ? { unit } : {}) });
  const BIG = [
    { name: 'count_people_groups', description: 'counts', inputSchema: { type: 'object', properties: {} } },
    { name: 'list_measures', description: 'the legend', inputSchema: { type: 'object', properties: {} } },
    { name: 'people_group_detail', description: 'Facts about one named people group. NOT for: counts.', inputSchema: { type: 'object', properties: { peopleNamePattern: { type: 'string' } }, required: ['peopleNamePattern'] }, _meta: meta('peoplegroup.detail', 'people-in-country entries') },
    { name: 'engagement_overview', description: 'Engagement verdicts by measure.', inputSchema: { type: 'object', properties: {} }, _meta: meta('peoplegroup.engagement.overview') },
  ];

  it('offers every peoplegroup.* capability the endpoint serves, in the catalog\'s own words', () => {
    const specs = peopleGroupToolsFrom(BIG);
    expect(specs.map((t) => t.id)).toEqual(['peoplegroup.count', 'peoplegroup.measures.list', 'peoplegroup.detail', 'peoplegroup.engagement.overview']);
    // The two this harness describes itself keep their hand-written specs — their `answers` phrasings are
    // what route "how many unreached people groups in India", and a generated description has no equal.
    expect(specs[0]).toBe(PEOPLE_GROUP_TOOLS[0]);
    expect(specs[1]).toBe(PEOPLE_GROUP_TOOLS[1]);
    // The rest are the endpoint's: its description (NOT-for routing included), its schema, its unit.
    const detail = specs.find((t) => t.id === 'peoplegroup.detail')!;
    expect(detail.description).toContain('NOT for: counts');
    expect(detail.description).toContain('people-in-country entries');
    expect(detail.inputSchema).toEqual({ type: 'object', properties: { peopleNamePattern: { type: 'string' } }, required: ['peopleNamePattern'] });
    expect(detail.establishes).toBe('lookup');
  });

  it('a catalog serving only the original two is unchanged — no new tool appears from nowhere', () => {
    expect(peopleGroupToolsFrom(SERVED).map((t) => t.id)).toEqual([PEOPLE_GROUP_COUNT_CAPABILITY, PEOPLE_GROUP_MEASURES_CAPABILITY]);
    expect(peopleGroupToolsFrom(null)).toEqual([]);
    expect(peopleGroupToolsFrom([])).toEqual([]);
  });

  it('ignores a tool whose capability is outside the namespace this branch routes', () => {
    // Dispatch recognises a people-group capability by its PREFIX, because a stateless Worker keeps no
    // registry between requests. A capability outside it cannot be routed here, so it is not offered.
    const mixed = [...SERVED, { name: 'search_resources', description: 'content', _meta: meta('catalog.resource.search') }, { name: 'weird', description: 'no meta' }];
    expect(peopleGroupToolsFrom(mixed).map((t) => t.id)).toEqual([PEOPLE_GROUP_COUNT_CAPABILITY, PEOPLE_GROUP_MEASURES_CAPABILITY]);
    expect(isPeopleGroupTool('peoplegroup.detail')).toBe(true);
    expect(isPeopleGroupTool('catalog.resource.search')).toBe(false);
  });

  it('two tools claiming one capability: the first wins rather than the last one listed', () => {
    const clash = [...SERVED, { name: 'a', _meta: meta('peoplegroup.detail') }, { name: 'b', _meta: meta('peoplegroup.detail') }];
    expect(peopleGroupCapabilities(clash).filter((c) => c.capability === 'peoplegroup.detail').map((c) => c.tool.name)).toEqual(['a']);
    expect(mcpToolFor(clash, 'peoplegroup.detail')).toBe('a');
  });

  it('resolves a capability to the tool name THAT endpoint publishes for it', () => {
    expect(mcpToolFor(BIG, 'peoplegroup.detail')).toBe('people_group_detail');
    expect(mcpToolFor(BIG, PEOPLE_GROUP_COUNT_CAPABILITY)).toBe('count_people_groups');
    expect(mcpToolFor(SERVED, 'peoplegroup.detail')).toBeNull();
  });

  it('calls a derived read by the endpoint\'s tool name, and carries the catalog\'s own unit and notes', async () => {
    const { f, calls } = fakeFetch({ structuredContent: { rows: [{ peopleName: 'Pashtun, Northern', population: 9_700_000 }], rowCount: 1, truncated: false, unit: 'people-in-country entries' } });
    const out = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, BIG, { fetch: f })('peoplegroup.detail', { peopleNamePattern: 'northern pashtun' }, {} as never);
    expect(calls[0]!.body.params!.name).toBe('people_group_detail');
    expect(out).toMatchObject({ count: 1, rows: [{ peopleName: 'Pashtun, Northern' }] });
    expect(String((out as { interpretation: string }).interpretation)).toContain('people-in-country entries');
    expect(String((out as { interpretation: string }).interpretation)).toContain('never add the two together');
  });

  it('A CAPPED LIST SAYS SO — rows.length is not the count', async () => {
    // Ten rows of fifty-seven. Reporting rows.length would turn "ten of fifty-seven" into "fifty-seven",
    // and nothing downstream could tell the difference.
    const rows = Array.from({ length: 10 }, (_, i) => ({ resourceName: `r${i}` }));
    const { f } = fakeFetch({ structuredContent: { rows, rowCount: 57, truncated: true, unit: 'resources' } });
    const out = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, BIG, { fetch: f })('peoplegroup.detail', { peopleNamePattern: 'x' }, {} as never) as { count: number; truncated?: boolean; interpretation: string };
    expect(out.count).toBe(57);
    expect(out.truncated).toBe(true);
    expect(out.interpretation).toContain('returned 57 in all');
    expect(out.interpretation).toContain('do not present these as the whole list');
  });

  it('AN EMPTY TABLE carries the catalog\'s sentence about what it does not mean', async () => {
    const noMatch = 'No match: the name or code was not found, which is not a statement that the people does not exist.';
    const { f } = fakeFetch({ structuredContent: { rows: [], rowCount: 0, truncated: false, noMatch } });
    const out = await peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, BIG, { fetch: f })('peoplegroup.detail', { peopleNamePattern: 'nosuch' }, {} as never) as { count: number; interpretation: string };
    expect(out.count).toBe(0);
    expect(out.interpretation).toContain('returned no rows');
    expect(out.interpretation).toContain('not a statement that the people does not exist');
  });

  it('reads tools/list ITSELF when the caller did not hand it one', async () => {
    // The call-time path (a routed step, an unattended run) has done no profile read. One lazy tools/list,
    // then the call — and a failed read is not remembered as "serves nothing".
    let n = 0;
    const f = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      n += 1;
      if (body.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: BIG } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { rows: [{ peopleName: 'x' }], rowCount: 1 } } }));
    }) as unknown as typeof fetch;
    const invoke = peopleGroupInvoker({ name: NAME, endpoint: ENDPOINT }, undefined, { fetch: f });
    expect(await invoke('peoplegroup.detail', { peopleNamePattern: 'x' }, {} as never)).toMatchObject({ count: 1 });
    expect(n).toBe(2);                 // tools/list, then tools/call
    await invoke('peoplegroup.detail', { peopleNamePattern: 'y' }, {} as never);
    expect(n).toBe(3);                 // the list is read once per invoker, not once per call
  });
});

describe('the card advertises what the agent is equipped to do', () => {
  // `people-groups.svc` could answer 24 questions and its card named 7 generic ones: the catalog profile
  // is mounted from the agent's own `atl:mcpEndpoint` record, so its tools do not exist until a
  // `tools/list` at plan time — and the card builder resolves no binding and does no such read.
  const playbook = (ids: string[], tools: Record<string, { id: string; description: string }> = {}) =>
    ({ capabilityIds: new Set(ids), tools });
  const LABELS = [{ id: 'gc:CFnPeopleGroupIntelligence', name: 'gc:CFnPeopleGroupIntelligence' }, { id: 'messaging.deliver', name: 'Deliver a message' }];

  it('adds the record-mounted capabilities the playbook declares, with the contract\'s own words', () => {
    const out = withRecordMountedSkills(LABELS, playbook(
      ['peoplegroup.count', 'peoplegroup.engagement.overview'],
      { 'peoplegroup.engagement.overview': { id: 'peoplegroup.engagement.overview', description: 'Engagement verdicts by measure. NOT for: counts.' } },
    ));
    expect(out.map((s) => s.id)).toEqual(['gc:CFnPeopleGroupIntelligence', 'messaging.deliver', 'peoplegroup.count', 'peoplegroup.engagement.overview']);
    // The planner and the card quote the same sentence.
    expect(out.find((s) => s.id === 'peoplegroup.engagement.overview')!.description).toContain('NOT for: counts');
    // A readable name from the id, not the raw dotted string.
    expect(out.find((s) => s.id === 'peoplegroup.engagement.overview')!.name).toBe('engagement overview');
  });

  it('leaves the card untouched when there is no playbook, and never duplicates a skill', () => {
    expect(withRecordMountedSkills(LABELS, null)).toBe(LABELS);
    expect(withRecordMountedSkills(LABELS, undefined)).toBe(LABELS);
    const already = [...LABELS, { id: 'peoplegroup.count', name: 'count' }];
    expect(withRecordMountedSkills(already, playbook(['peoplegroup.count'])).map((s) => s.id)).toEqual(already.map((s) => s.id));
  });

  it('advertises ONLY the record-mounted families — an archetype\'s other capabilities are not card entries', () => {
    // A person-steward playbook declares ~78 capabilities. The card is not the place for all of them: these
    // are the ones mounted from the AGENT'S OWN records, which is the gap being closed, and nothing wider.
    const out = withRecordMountedSkills([], playbook(['peoplegroup.detail', 'catalog.resource.search', 'treasury.pay', 'messaging.send', 'registry.search']));
    expect(out.map((s) => s.id)).toEqual(['catalog.resource.search', 'peoplegroup.detail']);
  });

  it('is sorted, so a released card\'s bytes do not depend on a Set\'s iteration order', () => {
    const forward = withRecordMountedSkills([], playbook(['peoplegroup.detail', 'peoplegroup.count', 'peoplegroup.networks']));
    const reverse = withRecordMountedSkills([], playbook(['peoplegroup.networks', 'peoplegroup.count', 'peoplegroup.detail']));
    expect(forward.map((s) => s.id)).toEqual(reverse.map((s) => s.id));
    expect(forward.map((s) => s.id)).toEqual(['peoplegroup.count', 'peoplegroup.detail', 'peoplegroup.networks']);
  });
});
