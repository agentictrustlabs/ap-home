// WHAT AN AGENT HOLDS — spec 419. "Which treasuries does this organization hold?", asked at missio-nexus.org, was answered
// first with the ASKER's own treasuries (every link read answered for the person asking) and then with a balance. The
// answer was already on chain: `ap:charteredUnder` is a countersigned PUBLIC edge (chartered-agents.ts, spec 355 W2), so
// what an agent holds is a fact any party could reproduce (ADR-0040) — no private tier is read and no standing is needed.
//
// Unnamed, the holder is THE AGENT BEING ASKED (the room). Each held agent is typed by its name suffix (ADR-0061); the read
// grants nothing — spending from a held treasury still needs its mandate.
import type { Address } from 'viem';
import type { ToolInvoker, ToolSpec } from '@agenticprimitives/orchestration';

export const HOLDINGS_READ_CAPABILITY = 'agent.holdings.list' as const;
const TYPES = ['treasury', 'team', 'org', 'household', 'workspace', 'svc', 'circle', 'church'] as const;

export const HOLDINGS_READ_TOOL: ToolSpec = {
  id: HOLDINGS_READ_CAPABILITY,
  description:
    'ANSWERS A QUESTION: which agents an agent HOLDS — the treasuries, teams, households, workspaces and services chartered '
    + 'under it — read from the public chartered-under record on chain. Use for "which treasuries does this organization hold", '
    + '"what teams do we have", "what does missio nexus hold". NOT the members of an organization (organization.membership.list) '
    + 'and NOT what the person asking is part of (person.affiliations.list). '
    + `Args: whose (the agent asked about — name or address; omit for the agent being asked), type (optional: ${TYPES.join(', ')}).`,
  inputSchema: { type: 'object', properties: {
    whose: { type: 'string', description: 'The agent whose holdings are asked about — its name or address. Omit for the agent being asked.' },
    type: { type: 'string', enum: [...TYPES], description: 'Only this kind of held agent. Omit for all.' },
  } },
  answers: ['which treasuries', 'what teams do we have', 'what does it hold', 'what we hold', 'chartered under'],
  // Rendered, not composed (spec 371 §2): the sentence is the read's own, with its partial-scan caveat when there is one.
  answer: '{{answer}}',
  establishes: 'lookup',
};

export interface HoldingsDeps {
  charteredAgents?: (owner: string, type: string) => Promise<Array<{ agent: string; name?: string }>>;
  nameOf?: (agent: string) => Promise<string | null>;
}

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

export function holdingsReadInvoker(deps: HoldingsDeps, addressee: Address): ToolInvoker {
  return async (_toolId, args) => {
    const interpretation = 'agents chartered under the holder, from the public chartered-under record on chain';
    if (!deps.charteredAgents) return { count: 0, held: [], refused: 'this agent cannot read the chartered-under record', interpretation };
    const raw = String((args as { whose?: unknown }).whose ?? '').trim();
    if (raw && !isAddr(raw)) return { count: 0, held: [], refused: `no agent called “${raw}” could be resolved`, interpretation };
    const holder = (raw || addressee).toLowerCase();
    const wanted = String((args as { type?: unknown }).type ?? '').trim().toLowerCase();
    if (wanted && !(TYPES as readonly string[]).includes(wanted)) return { count: 0, held: [], refused: `“${wanted}” is not a kind of agent this estate charters — the kinds are ${TYPES.join(', ')}`, interpretation };
    const rows = await deps.charteredAgents(holder, wanted || '*').catch(() => null);
    if (!rows) return { count: 0, held: [], refused: 'the chartered-under record could not be read just now', interpretation };
    const scanned = (rows as { scanned?: { read: number; of: number } }).scanned;
    const partial = scanned && scanned.of > scanned.read ? ` (read ${scanned.read} of the ${scanned.of} relationship edges on record — there may be more)` : '';
    const held = rows.map((r) => ({ agent: r.agent, name: r.name ?? r.agent, type: (r.name ?? '').toLowerCase().split('.').pop() || 'untyped' }));
    const holderName = (deps.nameOf ? await deps.nameOf(holder).catch(() => null) : null) ?? `${holder.slice(0, 8)}…${holder.slice(-4)}`;
    const byType: Record<string, number> = {};
    for (const h of held) byType[h.type] = (byType[h.type] ?? 0) + 1;
    return {
      holder, holderName, asked: wanted || 'all', count: held.length, held, byType, interpretation,
      ...(scanned ? { scanned } : {}),
      answer: held.length
        ? `${holderName} holds ${held.map((h) => h.name).join(', ')}${partial}.`
        : partial
          ? `${holderName} holds no ${wanted || 'chartered agent'} among the first ${scanned!.read} of its ${scanned!.of} relationship edges — the rest were not read, so there may be some.`
          : `${holderName} holds no ${wanted ? `${wanted}` : 'chartered agents'} on the chartered-under record.`,
    };
  };
}
