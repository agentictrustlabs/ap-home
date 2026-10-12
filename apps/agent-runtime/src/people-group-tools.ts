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

/**
 * THE TWO TOOLS THAT MAKE AN ENDPOINT THIS PROFILE. Not the whole surface any more — a catalog may serve
 * twenty-three reads or two, and both are this profile. These are the two every one of them has.
 */
export const PEOPLE_GROUP_MCP_TOOL_NAMES: readonly string[] = ['count_people_groups', 'list_measures'];

/** The capability ids this harness served before the catalog could describe its own, pinned by name. */
const PINNED: Record<string, string> = {
  count_people_groups: PEOPLE_GROUP_COUNT_CAPABILITY,
  list_measures: PEOPLE_GROUP_MEASURES_CAPABILITY,
};

/**
 * A tool as `tools/list` describes it. `_meta.capability` is how a catalog names the capability a tool
 * serves — without it a client must hold its own copy of the mapping, which is the same table written
 * twice and drifting from the first read that gets added.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: { capability?: string; unit?: string; owner?: string; license?: string };
}

/**
 * EVERY PEOPLE-GROUP CAPABILITY THE ENDPOINT SERVES, as the capability id the planner will pick.
 *
 * A capability id belongs to this harness's namespace (`peoplegroup.`) because recognising one at dispatch
 * must not require a list — `isPeopleGroupTool` is a prefix test, and a stateless Worker cannot keep a
 * registry between requests. A tool whose `_meta.capability` is outside that prefix is ignored: it may be
 * a perfectly good tool, but it is not one this branch knows how to route.
 */
export function peopleGroupCapabilities(served: readonly McpToolDescriptor[] | null | undefined): Array<{ capability: string; tool: McpToolDescriptor }> {
  const out: Array<{ capability: string; tool: McpToolDescriptor }> = [];
  const claimed = new Set<string>();
  for (const tool of served ?? []) {
    if (!tool?.name) continue;
    const capability = PINNED[tool.name] ?? tool._meta?.capability;
    if (!capability || !capability.startsWith('peoplegroup.')) continue;
    // FIRST CLAIM WINS, and a second is dropped rather than shadowing it: two tools offering one
    // capability would make which of them runs depend on the order `tools/list` happened to return.
    if (claimed.has(capability)) continue;
    claimed.add(capability);
    out.push({ capability, tool });
  }
  return out;
}

/** The capability id → MCP tool name mapping THIS endpoint publishes. */
export function mcpToolFor(served: readonly McpToolDescriptor[] | null | undefined, capability: string): string | null {
  return peopleGroupCapabilities(served).find((c) => c.capability === capability)?.tool.name ?? null;
}

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
/**
 * A PREFIX TEST, not a lookup. The set of people-group capabilities is whatever the bound catalog serves,
 * which is known only after a `tools/list` — but dispatch has to recognise one without that read, and a
 * stateless Worker keeps no registry between requests. So the namespace IS the answer: every capability
 * this branch routes lives under `peoplegroup.`, and the catalog's `_meta.capability` is required to as
 * well (`peopleGroupCapabilities`). An id outside it was never ours to route.
 */
export function isPeopleGroupTool(toolId: string): boolean {
  return PEOPLE_GROUP_TOOL_IDS.has(toolId) || toolId.startsWith('peoplegroup.');
}

/** The two the harness describes itself, by capability id — a catalog that serves only these is unchanged. */
const HAND_WRITTEN: Record<string, ToolSpec> = Object.fromEntries(PEOPLE_GROUP_TOOLS.map((t) => [t.id, t]));

/**
 * THE TOOLS TO OFFER FOR A BOUND CATALOG — ITS OWN, not a list compiled into this Worker.
 *
 * The catalog describes its reads in `tools/list`: a description written for a planner choosing between
 * them (each saying what it is NOT for and which read to use instead) and a JSON Schema for its
 * arguments. Deriving the specs from that is what lets a catalog grow from two reads to twenty-three
 * without a harness release — and stops the harness advertising a tool the endpoint does not serve, or
 * hiding one it does.
 *
 * The two capabilities this harness has always described keep their hand-written specs: their `answers`
 * phrasings are what the planner routes "how many unreached people groups in India" on, and a generated
 * description has no equivalent. Everything else is the catalog's own words.
 */
export function peopleGroupToolsFrom(served: readonly McpToolDescriptor[] | null | undefined): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const { capability, tool } of peopleGroupCapabilities(served)) {
    const pinned = HAND_WRITTEN[capability];
    if (pinned) { specs.push(pinned); continue; }
    const unit = tool._meta?.unit;
    specs.push({
      id: capability,
      description: `${tool.description ?? `The ${capability} read of this agent's own people-group catalog.`}`
        + `${unit ? ` Counting unit: ${unit}.` : ''}`
        + ' Every figure is a row the catalog returned — name its source and invent nothing beside the rows.',
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as ToolSpec['inputSchema'],
      establishes: 'lookup',
    });
  }
  return specs;
}

/**
 * WHAT AN ENDPOINT SERVES — one stateless `tools/list` at it, the tool names or null when it could not be read (an outage,
 * a non-MCP answer). Null is "unknown", never "none": the caller lists no profile's tools on it, and `remembered` does not
 * keep it (a failure is not remembered). The profiles are told apart by their tool names — the names ARE the profile.
 */
export async function toolsServedAt(endpoint: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<McpToolDescriptor[] | null> {
  const fetchImpl = opts.fetch ?? fetch;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8_000);
  try {
    const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: ctl.signal });
    if (!res.ok) return null;
    const rpc = await res.json() as { result?: { tools?: Array<Record<string, unknown>> } };
    const tools = rpc?.result?.tools;
    if (!Array.isArray(tools)) return null;
    // THE WHOLE DESCRIPTOR, not just the name: the description and schema are what a planner is given, and
    // `_meta.capability` is how the endpoint says which capability a tool serves. A name alone forces this
    // Worker to hold its own copy of that mapping.
    return tools.flatMap((t) => (typeof t?.name === 'string' && t.name ? [{
      name: t.name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      ...(t.inputSchema && typeof t.inputSchema === 'object' ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      ...(t._meta && typeof t._meta === 'object' ? { _meta: t._meta as McpToolDescriptor['_meta'] } : {}),
    }] : []));
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * An endpoint IS a profile when it serves every tool the profile names; unknown (null) serves none.
 *
 * Takes names or descriptors, because the content catalog asks this question of the same read. Serving
 * MORE than the profile names is still the profile — a catalog with twenty-three reads has the two.
 */
export function servesProfile(served: readonly (string | McpToolDescriptor)[] | null | undefined, required: readonly string[]): boolean {
  if (!served) return false;
  const have = new Set(served.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean));
  return required.every((n) => have.has(n));
}

interface CountRow { measure?: string; peopleInCountry?: number; distinctPeoples?: number }

/**
 * One stateless MCP `tools/call` at the bound catalog. The answer is the catalog's, said as such; an
 * outage is an outage.
 *
 * `served` is the endpoint's own `tools/list` — the same read the planner's tools were built from, so the
 * capability the planner picked resolves to the tool name THAT catalog publishes for it. Passing it in
 * (rather than consulting a table here) is what keeps the two in step.
 */
export function peopleGroupInvoker(binding: CatalogBinding | null, served?: readonly McpToolDescriptor[] | null, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): ToolInvoker {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  // The planner path hands these in — the same read its tools were built from. The call-time path (a
  // routed step, an unattended run) has not done that read, so it happens here, ONCE per invoker, and a
  // failure is not cached as "serves nothing": the next call tries again.
  let descriptors: readonly McpToolDescriptor[] | null | undefined = served;
  const resolve = async (): Promise<readonly McpToolDescriptor[] | null> => {
    if (descriptors) return descriptors;
    if (!binding) return null;
    const read = await toolsServedAt(binding.endpoint, { fetch: fetchImpl });
    if (read) descriptors = read;
    return read;
  };
  return async (toolId, args) => {
    const mcpTool = mcpToolFor(await resolve(), toolId);
    if (!mcpTool) {
      // A capability the planner offered that this catalog does not serve. Says WHICH it does, because the
      // answer is usually that a different read answers the question.
      const offered = peopleGroupCapabilities(descriptors).map((c) => c.capability);
      return { refused: `this agent's people-group catalog does not serve ${toolId}${offered.length ? ` — it serves ${offered.join(', ')}` : ''}` };
    }
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
    // WHAT THE CATALOG SAID ABOUT ITS OWN ANSWER, carried rather than recomputed. `rowCount` is the true
    // total and `rows` may be a prefix of it: reporting `rows.length` as the count would turn "ten of
    // fifty-seven" into "fifty-seven", and nothing downstream could tell. `noMatch` is the catalog's
    // sentence for an empty table — absent from the graph is not absent from the world.
    const rowCount = typeof v.rowCount === 'number' ? v.rowCount : undefined;
    const truncated = v.truncated === true;
    const noMatch = typeof v.noMatch === 'string' ? v.noMatch : undefined;
    const more = truncated && rowCount !== undefined ? ` Only the first rows are here: the catalog returned ${rowCount} in all, so say the total and do not present these as the whole list.` : '';
    if (toolId === PEOPLE_GROUP_COUNT_CAPABILITY) {
      const rows = Array.isArray(v.rows) ? (v.rows as CountRow[]).filter((x) => typeof x?.measure === 'string') : [];
      const f = (v.filters ?? {}) as { countryCode?: string; religion?: string; affinityBloc?: string };
      const where = `${f.countryCode && f.countryCode !== 'ALL' ? `country ${f.countryCode} (FIPS)` : 'all countries'}${f.religion && f.religion !== 'all' ? `, religion ~ "${f.religion}"` : ''}${f.affinityBloc && f.affinityBloc !== 'all' ? `, affinity bloc ~ "${f.affinityBloc}"` : ''}`;
      const lr = rows.find((x) => x.measure === 'jp-least-reached');
      return {
        count: rowCount ?? rows.length, rows, ...(truncated ? { truncated: true } : {}), ...(v.filters ? { filters: v.filters } : {}), ...(v.measures ? { measures: v.measures } : {}), ...(v.units ? { units: v.units } : {}), ...(v.source ? { gateway: v.source } : {}), source,
        interpretation: rows.length
          ? `${binding.name}'s people-group counts for ${where}, by measure${lr ? ` — Joshua Project's "unreached" (jp-least-reached): ${lr.peopleInCountry} people-in-country entries, ${lr.distinctPeoples} distinct peoples` : ''}. Quote the row that answers the question, name its source (Joshua Project vs IMB), and say which unit; invent nothing beside these rows${more}`
          : `${binding.name}'s people-group catalog returned no rows for ${where} — say so; do not supply a number from elsewhere.${noMatch ? ` ${noMatch}` : ''}`,
      };
    }
    if (toolId === PEOPLE_GROUP_MEASURES_CAPABILITY) {
      return { ...v, source, interpretation: `the legend of ${binding.name}'s people-group catalog: what each measure counts and whose list it is` };
    }
    // EVERY OTHER READ the catalog serves. The rows are its own and so is the unit; what this adds is the
    // standing instruction that applies to all of them, and the two things a reader cannot infer from the
    // rows alone — that the list is partial, or that an empty one is a statement about the graph.
    const rows = Array.isArray(v.rows) ? (v.rows as unknown[]) : [];
    return {
      count: rowCount ?? rows.length, ...(truncated ? { truncated: true } : {}), ...v, source,
      interpretation: rows.length
        ? `${binding.name}'s ${toolId} from its own people-group catalog${v.unit ? `, counted in ${String(v.unit)}` : ''}. Every figure is a returned row — name its publisher (Joshua Project and IMB are different lists with different definitions) and never add the two together.${more}`
        : `${binding.name}'s people-group catalog returned no rows for ${toolId} — say so; do not supply a figure from elsewhere.${noMatch ? ` ${noMatch}` : ''}`,
    };
  };
}
