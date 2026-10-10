// AN AGENT'S OWN PEOPLE-GROUP CATALOG AS A STEP — the twin of `catalog-tools.ts` (spec 387 W2's pattern) for a
// different profile. A service agent whose name record `atl:mcpEndpoint` names a people-group catalog (the AP
// people-group-catalog profile v1: count_people_groups / list_measures) answers counts from it. RECORDS FIRST: the
// binding is what the addressee's NAME publishes on chain — never a hostname convention, never a playbook field,
// never an env var of this Worker. And PROFILE BY WHAT IS SERVED: one record key names one endpoint, so which
// profile's tools to list is read from the endpoint's own `tools/list` (remembered a minute, `harness-run.ts`) —
// a people-group catalog is never offered the content catalog's tools, nor the reverse (fail closed: the planner
// cannot pick what is not listed, and a tool that cannot run is not listed).
//
// These are READS of PUBLIC counts (how many people groups, by list, for a country), R0: no mandate, no session,
// no vault. What comes back is the graph's count as the gateway serves it — evidence with a named source
// (Joshua Project, IMB, the Base List), never a record of ours. The planner never writes SPARQL: the tools are
// measures and filters, and the query is the catalog's. The A2A→MCP hop carries no authority because the catalog
// decides none (ADR-0041 governs hops where an authorization is made; a public read makes none).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { CatalogBinding } from './catalog-tools.js';

export const PEOPLE_GROUP_PROFILE = 'ap-people-group-catalog/v1' as const;
export const PEOPLE_GROUP_COUNT_CAPABILITY = 'peoplegroup.count' as const;
export const PEOPLE_GROUP_MEASURES_CAPABILITY = 'peoplegroup.measures.list' as const;

/** Capability id → the profile's MCP tool name. The mapping IS the profile; a catalog serving other names is not one. */
const MCP_TOOL: Record<string, string> = {
  [PEOPLE_GROUP_COUNT_CAPABILITY]: 'count_people_groups',
  [PEOPLE_GROUP_MEASURES_CAPABILITY]: 'list_measures',
};
/** What an endpoint must serve (`tools/list`) to be this profile. */
export const PEOPLE_GROUP_MCP_TOOL_NAMES: readonly string[] = Object.values(MCP_TOOL);

export const PEOPLE_GROUP_TOOLS: ToolSpec[] = [
  {
    id: PEOPLE_GROUP_COUNT_CAPABILITY,
    answers: ['how many people groups', 'unreached', 'unreached people groups', 'frontier people groups', 'least reached', 'people groups in', 'upg', 'uupg', 'fpg', 'how many peoples'],
    description:
      'COUNTS PEOPLE GROUPS from this agent\'s own people-group catalog (the Global Church graph: Joshua Project, IMB and the UUPG+ '
      + 'Base List) for a country, with optional religion and affinity-bloc filters. USE THIS for "how many unreached people groups '
      + 'are in India", "how many frontier peoples in Afghanistan", "how many Hindu people groups are there". Returns rows '
      + '{ measure, peopleInCountry, distinctPeoples }: "unreached" per Joshua Project is the row measure "jp-least-reached"; '
      + '"frontier" is "jp-frontier"; "jp-entries" is every JP entry; "imb-entries" and "base-list" are IMB\'s list and the '
      + 'deduplicated JP ∪ IMB Base List (absent when a religion or bloc filter is set). peopleInCountry counts people-in-country '
      + 'entries (one per people per country); distinctPeoples counts distinct ROP3 peoples. Always say whose count it is — '
      + '"unreached" differs by source. Args: countryCode (FIPS 10-4 two-letter code — "IN" India, "AF" Afghanistan, "LA" Laos; '
      + 'NOT ISO: Germany "GM", Japan "JA"; or "ALL", the default), religion (lower-case fragment of JP\'s primary religion, e.g. '
      + '"hinduism", "islam", "buddhism", "ethnic religions"; default "all"), affinityBloc (lower-case fragment of JP\'s affinity '
      + 'bloc, e.g. "south asian", "arab world", "deaf"; default "all").',
    inputSchema: {
      type: 'object',
      properties: {
        countryCode: { type: 'string', description: 'FIPS 10-4 two-letter country code ("IN", "AF") or "ALL" (default)' },
        religion: { type: 'string', description: 'Lower-case fragment of Joshua Project\'s primary religion, or "all" (default)' },
        affinityBloc: { type: 'string', description: 'Lower-case fragment of Joshua Project\'s affinity bloc, or "all" (default)' },
      },
    },
    establishes: 'lookup',
  },
  {
    id: PEOPLE_GROUP_MEASURES_CAPABILITY,
    answers: ['what measures', 'which lists', 'what does unreached mean', 'what counts'],
    description:
      'THE LEGEND of this agent\'s people-group catalog: every measure a count can return (jp-entries, jp-least-reached, jp-frontier, '
      + 'jp-frontier-no-engagement-report, imb-entries, base-list), whose list each comes from and what it means, plus the two '
      + 'counting units. Use it to explain a count or before choosing a measure; never invent a label. No args.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
  },
];

export const PEOPLE_GROUP_TOOL_IDS = new Set(PEOPLE_GROUP_TOOLS.map((t) => t.id));
export function isPeopleGroupTool(toolId: string): boolean { return PEOPLE_GROUP_TOOL_IDS.has(toolId); }

/**
 * WHAT AN ENDPOINT SERVES — one stateless `tools/list` at it, the tool names or null when it could not be read (an outage,
 * a non-MCP answer). Null is "unknown", never "none": the caller lists no profile's tools on it, and `remembered` does not
 * keep it (a failure is not remembered). The profiles are told apart by their tool names — the names ARE the profile.
 */
export async function toolsServedAt(endpoint: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<string[] | null> {
  const fetchImpl = opts.fetch ?? fetch;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: ctl.signal });
    if (!res.ok) return null;
    const rpc = await res.json() as { result?: { tools?: Array<{ name?: unknown }> } };
    const tools = rpc?.result?.tools;
    if (!Array.isArray(tools)) return null;
    return tools.map((t) => (typeof t?.name === 'string' ? t.name : '')).filter(Boolean);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** An endpoint IS a profile when it serves every tool the profile names; unknown (null) serves none. */
export function servesProfile(served: readonly string[] | null | undefined, required: readonly string[]): boolean {
  if (!served) return false;
  const have = new Set(served);
  return required.every((n) => have.has(n));
}

interface CountRow { measure?: string; peopleInCountry?: number; distinctPeoples?: number }

/** One stateless MCP `tools/call` at the bound catalog. The answer is the catalog's, said as such; an outage is an outage. */
export function peopleGroupInvoker(binding: CatalogBinding | null, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): ToolInvoker {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  return async (toolId, args) => {
    const mcpTool = MCP_TOOL[toolId];
    if (!mcpTool) return { refused: `${toolId} is not a people-group read` };
    if (!binding) return { refused: 'this agent publishes no people-group catalog in its name records (atl:mcpEndpoint) — nothing to count' };
    const t0 = Date.now();
    // The hop, on the result: which MCP tool was called with which arguments, and how long the catalog took — read by the
    // flow trace (spec 387 W2), so the catalog's part is visible from the outside.
    const source = { agent: binding.name, catalog: binding.endpoint, profile: PEOPLE_GROUP_PROFILE, tool: mcpTool, args: args ?? {}, ms: 0 };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: mcpTool, arguments: args ?? {} } });
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(binding.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, body, signal: ctl.signal });
    } catch (e) {
      source.ms = Date.now() - t0;
      return { error: `the people-group catalog at ${binding.endpoint} did not answer (${e instanceof Error ? e.message : String(e)})`, source, interpretation: 'the agent\'s people-group catalog could not be read — say so; nothing was counted' };
    } finally { clearTimeout(timer); }
    source.ms = Date.now() - t0;
    const text = await res.text();
    let rpc: { result?: { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } } | null = null;
    try { rpc = JSON.parse(text); } catch { rpc = null; }
    if (!res.ok || !rpc) return { error: `the people-group catalog at ${binding.endpoint} answered ${res.status}${rpc ? '' : ' with no JSON'}`, source, interpretation: 'the agent\'s people-group catalog could not be read — say so; nothing was counted' };
    if (rpc.error) return { error: rpc.error.message ?? 'the people-group catalog refused the call', source };
    const r = rpc.result ?? {};
    let value: unknown = r.structuredContent;
    if (value === undefined) { const t = r.content?.find((c) => typeof c.text === 'string')?.text; try { value = t ? JSON.parse(t) : null; } catch { value = t ?? null; } }
    if (r.isError) return { error: typeof value === 'object' && value && 'error' in value ? String((value as { error: unknown }).error) : 'the people-group catalog answered with an error', ...(typeof value === 'object' ? { detail: value } : {}), source, interpretation: 'the catalog could not count this — say why; do not supply a number from elsewhere' };
    const v = (typeof value === 'object' && value ? value : {}) as Record<string, unknown>;
    if (toolId === PEOPLE_GROUP_COUNT_CAPABILITY) {
      const rows = Array.isArray(v.rows) ? (v.rows as CountRow[]).filter((x) => typeof x?.measure === 'string') : [];
      const f = (v.filters ?? {}) as { countryCode?: string; religion?: string; affinityBloc?: string };
      const where = `${f.countryCode && f.countryCode !== 'ALL' ? `country ${f.countryCode} (FIPS)` : 'all countries'}${f.religion && f.religion !== 'all' ? `, religion ~ "${f.religion}"` : ''}${f.affinityBloc && f.affinityBloc !== 'all' ? `, affinity bloc ~ "${f.affinityBloc}"` : ''}`;
      const lr = rows.find((x) => x.measure === 'jp-least-reached');
      return {
        count: rows.length, rows, ...(v.filters ? { filters: v.filters } : {}), ...(v.measures ? { measures: v.measures } : {}), ...(v.units ? { units: v.units } : {}), ...(v.source ? { gateway: v.source } : {}), source,
        interpretation: rows.length
          ? `${binding.name}'s people-group counts for ${where}, by measure${lr ? ` — Joshua Project's "unreached" (jp-least-reached): ${lr.peopleInCountry} people-in-country entries, ${lr.distinctPeoples} distinct peoples` : ''}. Quote the row that answers the question, name its source (Joshua Project vs IMB), and say which unit; invent nothing beside these rows`
          : `${binding.name}'s people-group catalog returned no rows for ${where} — say so; do not supply a number from elsewhere`,
      };
    }
    return { ...v, source, interpretation: `the legend of ${binding.name}'s people-group catalog: what each measure counts and whose list it is` };
  };
}
