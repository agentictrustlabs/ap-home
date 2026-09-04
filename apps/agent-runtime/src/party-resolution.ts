// WHO DID THEY MEAN? — resolving a person's words to an agent, and asking when the words are not enough.
//
// "send 2 usdc from nathan to alice" is how people talk. `alice` is not a name the naming service knows
// (`unknown_tld: "alice" is not a root`), it is a HUMAN REFERENCE, and turning one into an agent is its own
// step with three honest outcomes:
//
//   certain     an address, or a typed name that resolves on chain — use it.
//   ambiguous   several agents answer to it. ASK which one. Picking the first, the nearest, or the
//               best-scoring is how money reaches the wrong Alice, and no ranking makes that safe.
//   unknown     nothing answers to it. ASK for the name or address, and say what was looked in.
//
// The last two are the point. A resolver that always returns something turns "I am not sure who you mean"
// into a confident wrong answer, and this one is used for payees.
//
// WHERE IT LOOKS, and what that excludes. The typed roots (`alice.me`, `alice.org`, …) are read from the
// CHAIN — authoritative and immediate. The public directory adds agents that describe themselves that way.
// Both are public (ADR-0040). It does NOT look in the asker's private relationships — who they share an
// organization or team with lives in their own vault (ADR-0025), which this agent cannot read and must not
// be handed to widen a search. That is a real limit: an "alice" known to Nathan only through a shared team
// and named nowhere public will not be found here, and the person is asked rather than guessed at.
import { InputRequired, type InputFieldV1 } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';

/** The roots a bare label might live under, most-likely first. A person is the common case for "alice". */
export const PARTY_ROOTS = ['me', 'org', 'team', 'treasury', 'workspace', 'svc', 'circle', 'church', 'registry'] as const;

export interface PartyLookups {
  /** Exact name → address, from the naming service on chain. */
  resolveName?: (name: string) => Promise<string | null>;
  /** Public directory search — returns what describes itself by these words. */
  findAgents?: (terms: string) => Promise<Array<{ name?: string | null; smartAgent?: string; displayName?: string | null }>>;
}

export interface PartyCandidate { name: string; agent: Address; displayName?: string }

// The PREFIX's case is not information. Insisting on a lowercase `0x` turned a perfectly good address
// into "I could not find that agent" and asked the person to try again — strict where it costs, and
// unhelpful where it does not.
const isAddress = (v: string): boolean => /^0[xX][0-9a-fA-F]{40}$/.test(v);

/** Every agent that answers to these words, deduplicated by address. */
export async function partyCandidates(raw: string, lookups: PartyLookups): Promise<PartyCandidate[]> {
  const label = raw.trim().toLowerCase();
  const byAddress = new Map<string, PartyCandidate>();
  const add = (name: string, agent?: string | null, displayName?: string | null) => {
    if (!agent || !isAddress(agent)) return;
    const key = agent.toLowerCase();
    if (!byAddress.has(key)) byAddress.set(key, { name, agent: key as Address, ...(displayName ? { displayName } : {}) });
  };
  // A dotted name is a NAME: resolve it as given and do not go looking for near-misses.
  if (label.includes('.')) {
    add(label, await lookups.resolveName?.(label).catch(() => null));
    return [...byAddress.values()];
  }
  // A bare label: which typed root does it live under? The chain answers exactly.
  const roots = await Promise.all(PARTY_ROOTS.map(async (r) => ({ name: `${label}.${r}`, agent: await lookups.resolveName?.(`${label}.${r}`).catch(() => null) })));
  for (const r of roots) add(r.name, r.agent);
  // …and whatever describes itself that way, for an agent whose label is not its name.
  for (const hit of (await lookups.findAgents?.(label).catch(() => [])) ?? []) {
    if (!hit.smartAgent) continue;
    const n = String(hit.name ?? hit.displayName ?? hit.smartAgent);
    if (!`${n} ${hit.displayName ?? ''}`.toLowerCase().includes(label)) continue; // a search may fuzz; we do not
    add(n, hit.smartAgent, hit.displayName ?? undefined);
  }
  return [...byAddress.values()];
}

/**
 * The address the person meant, or a question. `stepRef`/`toolId` place the question on the step that
 * needs it; `argName` is what a resume will answer.
 */
export async function resolveParty(
  raw: unknown,
  lookups: PartyLookups,
  where: { stepRef: string; toolId: string; argName: string; what: string },
): Promise<Address> {
  const value = String(raw ?? '').trim();
  if (isAddress(value)) return value.toLowerCase() as Address;
  const ask = (prompt: string, field: InputFieldV1): never => {
    throw new InputRequired({ kind: 'data', stepRef: where.stepRef, toolId: where.toolId, prompt, fields: [field] });
  };
  if (!value) ask(`Who is ${where.what}?`, { name: where.argName, label: where.what, type: 'text', required: true, hint: 'an agent name (alice.me) or address' });

  const found = await partyCandidates(value, lookups);
  if (found.length === 1) return found[0]!.agent;
  if (found.length === 0) {
    ask(
      `I could not find “${value}”. Which agent do you mean?`,
      { name: where.argName, label: where.what, type: 'text', required: true, hint: `nothing public answers to “${value}” — give the full name (e.g. ${value}.me) or the address` },
    );
  }
  // SEVERAL. Never pick: the person is the only one who knows which one they meant.
  ask(`Which “${value}” do you mean?`, {
    name: where.argName, label: where.what, type: 'choice', required: true,
    choices: found.map((c) => ({ value: c.agent, label: c.displayName ? `${c.displayName} — ${c.name}` : c.name })),
    hint: `${found.length} agents answer to “${value}”`,
  });
  throw new Error('unreachable');
}
