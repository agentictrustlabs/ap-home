// THE ENTERPRISE BEHIND A PERSON'S AGENT — spec 397 W2. Two capabilities every agent here offers when a registry is
// configured: FIND (an ARD search at the registry, planned deterministically from the person's intent — the registry
// finds and points, it never invokes) and ENGAGE (one message to a discovered agent, sent by THIS agent as the asker
// under the asker's standing: the subject-routed ask of spec 366 with the target planning for itself). What an outside
// agent says is an observation with its source named (spec 379) — never a record of ours, never authority. Neither
// capability spends anything: a discovered agent that would ACT parks the act for ITS steward (spec 374).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';

export const DISCOVERY_FIND_CAPABILITY = 'discovery.agents.find' as const;
export const ENGAGEMENT_INVOKE_CAPABILITY = 'engagement.agent.invoke' as const;

export const DISCOVERY_FIND_TOOL: ToolSpec = {
  id: DISCOVERY_FIND_CAPABILITY,
  answers: ['who offers', 'find a ministry', 'find an agent that', 'who can', 'who teaches', 'find services', 'discover'],
  verbs: ['find', 'discover'],
  description:
    'FINDS AGENTS IN THE PUBLIC REGISTRY BY WHAT THE PERSON WANTS — a ministry with a study on a doctrine, a service that '
    + 'offers a capability, a publisher on a subject. The registry searches its entries (public, on-chain-anchored facts) '
    + 'and answers with matching agents: name, description, declared capabilities, card, relevance. Use it BEFORE '
    + 'engagement.agent.invoke when the ask names a kind of agent rather than a specific one. It reads only; it authorizes '
    + 'nothing. Args: intent (what the person wants, in their words), capability (optional: a capability id or word to '
    + 'filter on, e.g. "study plans"), language (optional BCP-47 tag), limit (default 5, max 25).',
  inputSchema: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'What the person wants, in their words (e.g. "a study on justification")' },
      capability: { type: 'string', description: 'A capability id or word to filter by (optional)' },
      language: { type: 'string', description: 'A BCP-47 language tag (optional)' },
      limit: { type: 'integer', description: 'How many to return (default 5, max 25)' },
    },
    required: ['intent'],
  },
  establishes: 'lookup',
};

export const ENGAGEMENT_INVOKE_TOOL: ToolSpec = {
  id: ENGAGEMENT_INVOKE_CAPABILITY,
  answers: ['ask them', 'engage', 'what does the ministry say'],
  verbs: ['engage'],
  description:
    'ENGAGES A DISCOVERED AGENT: sends the person\'s words, as them, to another agent — one discovery.agents.find returned '
    + '(its name or address) or one the person named — and returns that agent\'s own answer, made under ITS OWN playbook '
    + 'from its own catalog or records (a study plan with links, a reading list, what it offers). Use it for "ask Ligonier for '
    + 'a six-week plan", "what does missio-nexus.org offer on prayer". The answer is that agent\'s, with its source named; '
    + 'it is never a record of ours. If the other agent needs its own steward\'s authority, it says so and the ask waits '
    + 'there. Args: agent (the name — ligonier.svc — or 0x address, as discovery returned it), message (what to ask, in the '
    + 'person\'s words, complete — the other agent sees only this).',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The other agent\'s name (ligonier.svc) or 0x address' },
      message: { type: 'string', description: 'The ask, complete and in the person\'s words' },
    },
    required: ['agent', 'message'],
  },
  establishes: 'submission',
};

export interface ArdSearchBody { query: { text: string; filter?: Record<string, string[]> }; pageSize: number; federation: 'none' }

/** DETERMINISTIC: the person's words become ONE registry query, reproducible by a reviewer. No model plans it. */
export function planFind(args: Record<string, unknown>): { body: ArdSearchBody; refused?: string } {
  const intent = String(args.intent ?? '').trim();
  const capability = String(args.capability ?? '').trim();
  const lang = String(args.language ?? '').trim().toLowerCase();
  const n = Number(args.limit);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 25) : 5;
  if (lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(lang)) return { body: { query: { text: '' }, pageSize: limit, federation: 'none' }, refused: `language must be a BCP-47 tag (got “${args.language}”)` };
  if (!intent && !capability) return { body: { query: { text: '' }, pageSize: limit, federation: 'none' }, refused: 'say what the person wants (intent), a capability, or both — the registry needs a question' };
  const filter: Record<string, string[]> = {};
  if (capability) filter.capabilities = [capability];
  if (lang) filter['ap:language'] = [lang];
  return { body: { query: { text: intent || capability, ...(Object.keys(filter).length ? { filter } : {}) }, pageSize: limit, federation: 'none' } };
}

export interface FoundAgent {
  agent: string | null; name: string | null; displayName: string; description?: string; capabilities: string[];
  card: string | null; website: string | null; agentType?: string; registryStatus?: string; relevance: number | null;
  evidence?: unknown;
}

export interface EnterpriseDeps {
  /** The registry's origin (`ARD_REGISTRY_ORIGIN`); absent ⇒ the find tool is not offered at all. */
  registryOrigin?: string;
  fetch?: typeof fetch;
  nameOf?: (address: string) => Promise<string | null>;
}

/** The ONE mechanism (ADR-0013): the registry's ARD `POST /search`. A registry error is the tool's refusal, in its words. */
export function discoveryFindInvoker(deps: EnterpriseDeps): ToolInvoker {
  return async (_toolId, args) => {
    const origin = (deps.registryOrigin ?? '').replace(/\/$/, '');
    if (!/^https?:\/\//.test(origin)) return { refused: 'no agent registry is configured for this deployment' };
    const plan = planFind(args);
    if (plan.refused) return { refused: plan.refused };
    const url = `${origin}/search`;
    let res: Response;
    try { res = await (deps.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(plan.body) }); }
    catch (e) { return { refused: `the registry at ${origin} could not be reached: ${e instanceof Error ? e.message : String(e)}`, query: plan.body }; }
    const out = (await res.json().catch(() => null)) as { results?: Array<Record<string, unknown>>; error?: unknown } | null;
    if (!res.ok || !out) return { refused: `the registry answered ${res.status}${out?.error ? `: ${typeof out.error === 'string' ? out.error : JSON.stringify(out.error).slice(0, 160)}` : ''}`, query: plan.body };
    const rows = Array.isArray(out.results) ? out.results : [];
    const agents: FoundAgent[] = await Promise.all(rows.map(async (e) => {
      const agent = typeof e['ap:canonicalAgentId'] === 'string' ? (e['ap:canonicalAgentId'] as string).toLowerCase() : null;
      const name = agent && deps.nameOf ? await deps.nameOf(agent).catch(() => null) : null;
      return {
        agent, name,
        displayName: String(e.displayName ?? e.identifier ?? ''),
        ...(typeof e.description === 'string' ? { description: e.description } : {}),
        capabilities: Array.isArray(e.capabilities) ? e.capabilities.map(String) : [],
        card: typeof e.url === 'string' ? e.url : null,
        website: typeof e['ap:siteUrl'] === 'string' ? (e['ap:siteUrl'] as string) : null,
        ...(typeof e['ap:agentType'] === 'string' ? { agentType: e['ap:agentType'] as string } : {}),
        ...(typeof e['ap:registryStatus'] === 'string' ? { registryStatus: e['ap:registryStatus'] as string } : {}),
        relevance: typeof e.score === 'number' ? e.score : null,
        ...(e['ap:trustEvidence'] ? { evidence: e['ap:trustEvidence'] } : {}),
      };
    }));
    return {
      agents,
      query: plan.body,
      referral: { registry: url },
      interpretation: `asked the registry at ${origin} for “${plan.body.query.text}”${plan.body.query.filter?.capabilities ? ` with capability ${plan.body.query.filter.capabilities.join(', ')}` : ''}${plan.body.query.filter?.['ap:language'] ? ` in ${plan.body.query.filter['ap:language'].join(', ')}` : ''}`,
      note: agents.length
        ? `${agents.length} agent(s) from the public registry, ordered by relevance — public facts, never a record of ours and never authority; engage one by its name or address.`
        : 'nothing registered matched; the registry was asked, not guessed for.',
    };
  };
}
