import { describe, it, expect } from 'vitest';
import { searchWeb, webSearchInvoker, WEB_SEARCH } from '../src/web-search.js';

const xai = (calls: Array<Record<string, unknown>> = []) => (async (_url: string | URL | Request, init?: RequestInit) => {
  calls.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ output: [
    { type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://a.example/1' }, { type: 'url', url: 'https://b.example/2' }] } },
    { type: 'message', content: [{ type: 'output_text', text: 'Here: {"results":[{"title":"A","url":"https://a.example/1","summary":"About A."},{"title":"bad","url":"javascript:x","summary":""}]}' }] },
  ], usage: { server_side_tool_usage_details: { web_search_calls: 1 } } }));
}) as unknown as typeof fetch;

describe('web search as evidence (spec 403 W3)', () => {
  it('sources are what the search hit; results the model\'s reading, bounded and http-only; marked untrusted', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const out = await searchWeb({ XAI_API_KEY: 'k' }, 'retreat venues', 3, xai(calls));
    expect(out.sources).toEqual(['https://a.example/1', 'https://b.example/2']); expect(out.results).toEqual([{ title: 'A', url: 'https://a.example/1', summary: 'About A.' }]);
    expect(out.untrusted).toBe(true); expect(out.searches).toBe(1); expect(calls[0]!.tools).toEqual([{ type: 'web_search' }]); expect(String(calls[0]!.input)).toContain('at most 3');
  });
  it('no key ⇒ a stated outcome, never a scrape; a provider error is said', async () => {
    const inv = webSearchInvoker({});
    const r = await inv(WEB_SEARCH, { query: 'x' }, {} as never) as { searched: boolean; refused: string };
    expect(r.searched).toBe(false); expect(r.refused).toMatch(/no search provider/);
    const bad = webSearchInvoker({ XAI_API_KEY: 'k' }, (async () => new Response(JSON.stringify({ error: 'quota' }), { status: 429 })) as unknown as typeof fetch);
    expect(((await bad(WEB_SEARCH, { query: 'venues' }, {} as never)) as { refused: string }).refused).toMatch(/429/);
  });
});
