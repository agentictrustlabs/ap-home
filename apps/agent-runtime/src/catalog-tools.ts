// AN AGENT'S OWN CATALOG AS A STEP — spec 387 W2. A service agent whose name record `atl:mcpEndpoint` names a
// content catalog (the AP content-catalog profile v1: search_resources / list_topics / get_resource) answers
// from it. RECORDS FIRST: the binding is what the addressee's NAME publishes on chain — never a hostname
// convention, never a playbook field, never an env var of this Worker. A name that publishes no endpoint
// offers no catalog tools at all (fail closed: the planner cannot pick what is not listed).
//
// These are READS of PUBLIC metadata (titles, identifiers, links, facets), R0: no mandate, no session, no
// vault. What comes back is the publisher's catalog as the publisher serves it — evidence with a named
// source, never a record of ours. A catalog that returns prose would be a different contract; this one
// never asks for any. The A2A→MCP hop here carries no authority because the catalog decides none
// (ADR-0041 governs hops where an authorization is made; a public read makes none).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';

export const CATALOG_PROFILE = 'ap-content-catalog/v1' as const;
export const CATALOG_SEARCH_CAPABILITY = 'catalog.resource.search' as const;
export const CATALOG_TOPICS_CAPABILITY = 'catalog.topic.list' as const;
export const CATALOG_GET_CAPABILITY = 'catalog.resource.get' as const;

/** Capability id → the profile's MCP tool name. The mapping IS the profile; a catalog serving other names is not one. */
const MCP_TOOL: Record<string, string> = {
  [CATALOG_SEARCH_CAPABILITY]: 'search_resources',
  [CATALOG_TOPICS_CAPABILITY]: 'list_topics',
  [CATALOG_GET_CAPABILITY]: 'get_resource',
};

export const CATALOG_TOOLS: ToolSpec[] = [
  {
    id: CATALOG_SEARCH_CAPABILITY,
    answers: ['resources', 'teaching', 'series', 'messages', 'articles', 'books', 'podcasts', 'what do you have on', 'study', 'study plan', 'curriculum', 'course', 'lessons', 'reading plan'],
    description:
      'SEARCHES THIS AGENT\'S OWN CONTENT CATALOG — the series, messages, articles, podcasts, books and courses it publishes — '
      + 'and returns matching items as metadata (title, link, type, teacher, series, scripture, length, date, free or gated). '
      + 'USE THIS for any ask about what this agent teaches, offers or recommends on a subject, and as the ONLY source when '
      + 'asked to build a study plan, curriculum, reading list or course from its material: search first, then compose the '
      + 'plan from the items returned, citing each by its link. It never returns prose and nothing may be invented beside it. '
      + 'Args: query (words to match, optional), topic (a topic slug or code, e.g. "justification"), type (an item type, '
      + 'optional), teacher (a teacher slug, optional), free (true ⇒ only items streamable without purchase), limit (default 20, max 50).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against titles, series, teachers and topics' },
        topic: { type: 'string', description: 'A topic slug or code from the catalog, e.g. "justification"' },
        type: { type: 'string', description: 'An item type, e.g. "teaching-series-message", "article", "podcast-episode", "store-product"' },
        teacher: { type: 'string', description: 'A teacher slug, e.g. "r-c-sproul"' },
        free: { type: 'boolean', description: 'Only items that stream without a purchase' },
        limit: { type: 'integer', description: 'How many to return (default 20, max 50)' },
      },
    },
    establishes: 'lookup',
  },
  {
    id: CATALOG_TOPICS_CAPABILITY,
    answers: ['topics', 'subjects', 'what topics', 'what subjects', 'what do you cover'],
    description:
      'LISTS THE TOPICS of this agent\'s own content catalog, one level of the tree at a time, each with how many items sit under it. '
      + 'Use it to learn what the catalog covers or to find the slug of a topic before searching. Args: parent (a topic slug or code; omitted ⇒ the top level).',
    inputSchema: { type: 'object', properties: { parent: { type: 'string', description: 'A topic slug or code whose children to list; omitted ⇒ the top level' } } },
    establishes: 'lookup',
  },
  {
    id: CATALOG_GET_CAPABILITY,
    answers: ['details of', 'more about', 'tell me about'],
    description:
      'ONE ITEM of this agent\'s own content catalog by its id, catalog code or slug — its full metadata record (link, teachers, '
      + 'series, scripture, related topics, length, date, availability). Args: id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The item\'s id, catalog code or slug, as a search returned it' } }, required: ['id'] },
    establishes: 'lookup',
  },
];

export const CATALOG_TOOL_IDS = new Set(CATALOG_TOOLS.map((t) => t.id));
export function isCatalogTool(toolId: string): boolean { return CATALOG_TOOL_IDS.has(toolId); }

export interface CatalogBinding { name: string; endpoint: string }
export interface CatalogDeps {
  nameOf?: (address: string) => Promise<string | null>;
  readNameRecords?: (name: string) => Promise<{ mcpEndpoint?: string } | null>;
}

/** The addressee's catalog, from its NAME'S RECORDS — or null: no name, no record, no https endpoint ⇒ no catalog. */
export async function catalogBindingFor(deps: CatalogDeps, addressee: string | undefined): Promise<CatalogBinding | null> {
  if (!addressee || !deps.nameOf || !deps.readNameRecords) return null;
  const name = await deps.nameOf(addressee).catch(() => null);
  if (!name) return null;
  const records = await deps.readNameRecords(name).catch(() => null);
  const endpoint = records?.mcpEndpoint?.trim();
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return null;
  return { name, endpoint };
}

interface CatalogItem {
  id?: string; title?: string; url?: string; type?: string; teachers?: Array<{ name?: string }>; container?: { name?: string; url?: string } | null;
  topicPath?: Array<{ name?: string }>; scripture?: string | null; durationSeconds?: number | null; publishedOn?: string | null; freeStream?: boolean | null; gated?: boolean | null;
}
/** What the planner and composer see of an item: enough to choose it and cite it, nothing to paraphrase. */
export function slimItem(r: CatalogItem): Record<string, unknown> {
  return {
    ...(r.id ? { id: r.id } : {}), title: r.title ?? '', url: r.url ?? '', ...(r.type ? { type: r.type } : {}),
    ...(r.teachers?.length ? { teachers: r.teachers.map((t) => t.name).filter(Boolean) } : {}),
    ...(r.container?.name ? { series: r.container.name, ...(r.container.url ? { seriesUrl: r.container.url } : {}) } : {}),
    ...(r.topicPath?.length ? { topics: r.topicPath.map((t) => t.name).filter(Boolean) } : {}),
    ...(r.scripture ? { scripture: r.scripture } : {}),
    ...(typeof r.durationSeconds === 'number' && r.durationSeconds > 0 ? { minutes: Math.round(r.durationSeconds / 60) } : {}),
    ...(r.publishedOn ? { publishedOn: r.publishedOn } : {}),
    ...(r.freeStream === true ? { free: true } : r.gated === true ? { gated: true } : {}),
  };
}

/** One stateless MCP `tools/call` at the bound catalog. The answer is the catalog's, said as such; an outage is an outage. */
export function catalogInvoker(binding: CatalogBinding | null, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): ToolInvoker {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  return async (toolId, args) => {
    const mcpTool = MCP_TOOL[toolId];
    if (!mcpTool) return { refused: `${toolId} is not a catalog read` };
    if (!binding) return { refused: 'this agent publishes no content catalog in its name records (atl:mcpEndpoint) — nothing to search' };
    const source = { agent: binding.name, catalog: binding.endpoint, profile: CATALOG_PROFILE };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: mcpTool, arguments: args ?? {} } });
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(binding.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, body, signal: ctl.signal });
    } catch (e) {
      return { error: `the catalog at ${binding.endpoint} did not answer (${e instanceof Error ? e.message : String(e)})`, source, interpretation: 'the agent\'s catalog could not be read — say so; nothing was searched' };
    } finally { clearTimeout(timer); }
    const text = await res.text();
    let rpc: { result?: { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } } | null = null;
    try { rpc = JSON.parse(text); } catch { rpc = null; }
    if (!res.ok || !rpc) return { error: `the catalog at ${binding.endpoint} answered ${res.status}${rpc ? '' : ' with no JSON'}`, source, interpretation: 'the agent\'s catalog could not be read — say so; nothing was searched' };
    if (rpc.error) return { error: rpc.error.message ?? 'the catalog refused the call', source };
    const r = rpc.result ?? {};
    let value: unknown = r.structuredContent;
    if (value === undefined) { const t = r.content?.find((c) => typeof c.text === 'string')?.text; try { value = t ? JSON.parse(t) : null; } catch { value = t ?? null; } }
    if (r.isError) return { error: typeof value === 'object' && value && 'error' in value ? String((value as { error: unknown }).error) : 'the catalog answered with an error', ...(typeof value === 'object' ? { detail: value } : {}), source };
    const v = (typeof value === 'object' && value ? value : {}) as Record<string, unknown>;
    if (toolId === CATALOG_SEARCH_CAPABILITY) {
      const resources = Array.isArray(v.resources) ? (v.resources as CatalogItem[]).map(slimItem) : [];
      return {
        count: resources.length, total: typeof v.total === 'number' ? v.total : resources.length, resources,
        ...(v.types && typeof v.types === 'object' ? { types: v.types } : {}), ...(v.filters ? { filters: v.filters } : {}), source,
        interpretation: resources.length
          ? `${resources.length} item(s) of ${binding.name}'s own catalog (of ${typeof v.total === 'number' ? v.total : resources.length} matching) — metadata as the publisher lists it: cite each item by its link; compose from these and invent nothing beside them`
          : `${binding.name}'s catalog lists nothing matching — say so; do not supply items from elsewhere`,
      };
    }
    if (toolId === CATALOG_TOPICS_CAPABILITY) {
      return { ...v, source, interpretation: `the topics of ${binding.name}'s own catalog${v.parent ? ` under ${JSON.stringify(v.parent)}` : ''}, with item counts` };
    }
    return { ...v, ...(v.found && v.resource ? { resource: slimItem(v.resource as CatalogItem), record: v.resource } : {}), source, interpretation: v.found ? `one item of ${binding.name}'s own catalog, in full` : `${binding.name}'s catalog has no such item` };
  };
}
