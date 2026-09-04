// WHAT THE ASK MAY READ — the public agent knowledge base, through discovery, and nothing else.
//
// Two sources, and the difference matters. The DIRECTORY (discovery) answers "who is out there like X" —
// it is a projection, and a projection lags: an agent created a minute ago is not in it yet. The NAMING
// SERVICE answers "who holds exactly this name" from the chain, immediately. An ask that names an agent
// gets the chain; an ask that describes one gets the directory. Reaching for the directory to answer an
// exact name is how "fund alice2.treasury" came back as "no such agent" about an agent that existed.
//
// ADR-0040 is the whole design here, in both directions:
//
//   READ  — the KB holds ONLY public, on-chain-derivable facts. Reading all of it reveals nothing that
//           reading the chain would not. So these tools need no authority, carry no delegation, and are
//           classified `informational`: an Ask can compose them before anyone has granted anything.
//   WRITE — there is NO write. The indexer is the KB's only writer (ADR-0040). Nothing on this path may
//           push a viewer-derived fact back — not the asker, not the question, not the mandate, not the
//           receipt. A new agent an Ask creates becomes public the way everything else does: it is ON
//           CHAIN, and the indexer projects it. We never hand discovery a fact the chain does not have.
//
// What we send is therefore also bounded. A query string reaches GraphDB and may be logged there, so the
// tools take SEARCH TERMS and addresses — never the person's sentence, never who is asking, never the run.
// The planner is told this in the tool descriptions, because a tool that could leak is a tool that will.
//
// WHY NOT RAW SPARQL. The Ask has no playbook to describe a vocabulary with (the discussion and endeavor
// turns do — spec 327 §4b / 334 §6 — which is why raw SPARQL stays there and not here). Asked to write
// SPARQL against a schema it half-knows, a planner invents one: the first live Ask produced
// `VALUES ?type { <https://vocab.account.tech/types/Person> … }` and would have answered "I don't know"
// with total confidence had the endpoint accepted it. Capability-shaped tools cannot fail that way.
//
// TRANSPORT — the same seam `discovery-facets.ts` uses: a same-account SERVICE BINDING (Workers cannot
// fetch sibling workers.dev hosts — error 1042), a base URL in dev. Unreachable ⇒ the tool THROWS, which
// makes the step fail honestly; it never returns an empty result that reads like "there are none".
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { DiscoveryEnv } from './discovery-facets.js';

const MAX_ROWS = 25;

async function discovery(env: DiscoveryEnv, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = env.DISCOVERY_MCP
    ? await env.DISCOVERY_MCP.fetch(`https://discovery-mcp${path}`, init)
    : env.DISCOVERY_MCP_BASE?.trim()
      ? await fetch(`${env.DISCOVERY_MCP_BASE.replace(/\/$/, '')}${path}`, init)
      : null;
  if (!res) throw new Error('the public agent directory is not reachable from this agent (no discovery binding)');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || body.ok !== true) throw new Error(`the public agent directory returned ${res.status}${body?.error ? `: ${String(body.error)}` : ''}`);
  return body;
}

/** The Ask's read tools. All `informational` — no `capability`, so the loop never asks for authority to
 *  read what the chain already publishes. */
export const ASK_DISCOVERY_TOOLS: ToolSpec[] = [
  {
    id: 'resolve_agent_name',
    description:
      'Resolve an exact agent NAME (e.g. "alice2.treasury", "outreach.team", "bob.me") to its smart-agent '
      + 'address, from the naming service ON CHAIN. Use this whenever the ask names an agent: it is '
      + 'authoritative and immediate, where the directory reflects what has been indexed and lags a '
      + 'newly-created agent. Returns null when nothing holds that name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The full typed name, e.g. outreach.team' } }, required: ['name'] },
  },
  {
    id: 'find_agents',
    description:
      'Search the PUBLIC agent directory for agents (people, organizations, teams, services) by name or ' +
      'by what they do. `terms` are search words only — never the user\'s full question, and never who is ' +
      'asking. Returns public, on-chain-derived facts: name, address, kind, declared capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'string', description: 'Search words, e.g. "outreach team greeley". Keep it to the entities being asked about.' },
        limit: { type: 'number', description: `How many rows (max ${MAX_ROWS}).` },
      },
      required: ['terms'],
    },
  },
  {
    id: 'get_agent',
    description:
      'Read one agent from the PUBLIC directory by its typed name (e.g. "outreach.team") or its 0x smart-agent ' +
      'address. Returns its public profile, declared type and capabilities. Use this when the ask names a ' +
      'specific agent.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'A typed name or a 0x address.' } }, required: ['key'] },
  },
  {
    id: 'list_agent_facets',
    description:
      'The shape of the PUBLIC directory: which agent types, name suffixes and capability ids exist, with ' +
      'how many agents declare each. Use it to answer "what kinds of agents are there" and to pick valid ' +
      'terms before searching. Needs no arguments.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const ASK_DISCOVERY_TOOL_IDS = new Set(ASK_DISCOVERY_TOOLS.map((t) => t.id));

/** Invoke one discovery read. Public data only, in and out. */
export function askDiscoveryInvoker(env: DiscoveryEnv & { resolveName?: (name: string) => Promise<string | null> }): ToolInvoker {
  return async (toolId, args) => {
    if (toolId === 'resolve_agent_name') {
      const name = String((args as { name?: unknown }).name ?? '').trim().toLowerCase();
      if (!name) throw new Error('resolve_agent_name needs a name');
      if (!env.resolveName) throw new Error('name resolution is not wired on this agent');
      // The CHAIN is the answer here, not the index. An agent created a minute ago resolves; the
      // directory may not have seen it yet, and answering "no such agent" about one that exists is
      // worse than answering slowly.
      const agent = await env.resolveName(name);
      return { name, agent, found: !!agent };
    }
    if (toolId === 'find_agents') {
      const terms = String((args as { terms?: unknown }).terms ?? '').trim();
      if (!terms) throw new Error('find_agents needs search terms');
      const limit = Math.min(Number((args as { limit?: unknown }).limit ?? MAX_ROWS) || MAX_ROWS, MAX_ROWS);
      const body = await discovery(env, `/search?q=${encodeURIComponent(terms)}&limit=${limit}`);
      const agents = (body.agents ?? body.results ?? []) as unknown[];
      return { agents, count: agents.length };
    }
    if (toolId === 'get_agent') {
      const key = String((args as { key?: unknown }).key ?? '').trim();
      if (!key) throw new Error('get_agent needs a name or address');
      const { ok, ...agent } = await discovery(env, `/agent?key=${encodeURIComponent(key)}`);
      void ok;
      return agent;
    }
    if (toolId === 'list_agent_facets') {
      const { ok, ...facets } = await discovery(env, '/facets');
      void ok;
      return facets;
    }
    throw new Error(`${toolId} is not a discovery read`);
  };
}
