import { describe, it, expect } from 'vitest';
import { CATALOG_TOOLS, CATALOG_SEARCH_CAPABILITY, CATALOG_GET_CAPABILITY, catalogBindingFor, catalogInvoker, isCatalogTool, slimItem } from '../src/catalog-tools.js';

const NAME = 'ligonier.svc'; const SA = '0x38b502cd2902f2d91ca24032e0f2076fc2749347'; const ENDPOINT = 'https://catalog.example/mcp';
const deps = (records: Record<string, { mcpEndpoint?: string } | null>) => ({ nameOf: async (a: string) => (a === SA ? NAME : null), readNameRecords: async (n: string) => records[n] ?? null });
const fakeFetch = (result: unknown, status = 200) => {
  const calls: Array<{ url: string; body: { params: { name: string; arguments: unknown } } }> = [];
  const f = (async (url: string, init?: RequestInit) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status }); }) as unknown as typeof fetch;
  return { f, calls };
};

describe('spec 387 W2 — the agent\'s own catalog as a step', () => {
  it('binds by the NAME\'S RECORDS or not at all: no name, no record, a non-https record ⇒ no catalog', async () => {
    expect(await catalogBindingFor(deps({ [NAME]: { mcpEndpoint: ENDPOINT } }), SA)).toEqual({ name: NAME, endpoint: ENDPOINT });
    expect(await catalogBindingFor(deps({ [NAME]: {} }), SA)).toBeNull();
    expect(await catalogBindingFor(deps({ [NAME]: { mcpEndpoint: 'http://plain.example/mcp' } }), SA)).toBeNull();
    expect(await catalogBindingFor(deps({ [NAME]: { mcpEndpoint: ENDPOINT } }), '0x' + '1'.repeat(40))).toBeNull();
    expect(await catalogBindingFor({}, SA)).toBeNull();
    expect(CATALOG_TOOLS.map((t) => t.id).every(isCatalogTool)).toBe(true);
    expect(isCatalogTool('treasury.payment.execute')).toBe(false);
  });
  it('a search is ONE MCP tools/call at the bound endpoint, its items slimmed to what can be chosen and cited', async () => {
    const item = { id: 'r1', title: 'Justification by Faith Alone', url: 'https://learn.example/x', type: 'teaching-series-message', teachers: [{ name: 'R.C. Sproul', slug: 'r-c-sproul' }], container: { name: 'God Alone', url: 'https://learn.example/s' }, topicPath: [{ name: 'Justification' }], scripture: 'Rom.3.28', durationSeconds: 1500, publishedOn: '2020-01-01', freeStream: true, gated: false };
    const { f, calls } = fakeFetch({ structuredContent: { total: 104, resources: [item], types: { 'teaching-series-message': 1 }, filters: { topic: { name: 'Justification', code: '1.5.5' } } } });
    const out = await catalogInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })(CATALOG_SEARCH_CAPABILITY, { topic: 'justification', limit: 1 }, {} as never) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.body.params).toEqual({ name: 'search_resources', arguments: { topic: 'justification', limit: 1 } });
    expect(out).toMatchObject({ count: 1, total: 104, source: { agent: NAME, catalog: ENDPOINT, profile: 'ap-content-catalog/v1' } });
    expect((out.resources as unknown[])[0]).toEqual({ id: 'r1', title: 'Justification by Faith Alone', url: 'https://learn.example/x', type: 'teaching-series-message', teachers: ['R.C. Sproul'], series: 'God Alone', seriesUrl: 'https://learn.example/s', topics: ['Justification'], scripture: 'Rom.3.28', minutes: 25, publishedOn: '2020-01-01', free: true });
    expect(String(out.interpretation)).toMatch(/cite each item by its link/);
    expect(slimItem({ title: 't', url: 'u', gated: true })).toEqual({ title: 't', url: 'u', gated: true });
  });
  it('no binding refuses; an outage, a non-JSON answer and a catalog error are each said as such — nothing is guessed', async () => {
    expect(await catalogInvoker(null)(CATALOG_SEARCH_CAPABILITY, {}, {} as never)).toMatchObject({ refused: expect.stringContaining('atl:mcpEndpoint') });
    const down = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await catalogInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: down })(CATALOG_SEARCH_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('did not answer') });
    const html = (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch;
    expect(await catalogInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: html })(CATALOG_SEARCH_CAPABILITY, {}, {} as never)).toMatchObject({ error: expect.stringContaining('502') });
    const { f } = fakeFetch({ isError: true, structuredContent: { found: false, id: 'x' } });
    expect(await catalogInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })(CATALOG_GET_CAPABILITY, { id: 'x' }, {} as never)).toMatchObject({ error: 'the catalog answered with an error', detail: { found: false } });
    expect(await catalogInvoker({ name: NAME, endpoint: ENDPOINT }, { fetch: f })('treasury.payment.execute', {}, {} as never)).toMatchObject({ refused: expect.stringContaining('not a catalog read') });
  });
});
