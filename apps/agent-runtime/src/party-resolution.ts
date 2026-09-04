// WHO DID THEY MEAN? — resolving a person's words to an agent, in the tier where knowing them lives.
//
// "send 2 usdc from nathan to alice" is how people talk. `alice` is not a name the naming service knows
// (`unknown_tld`), it is a HUMAN REFERENCE, and turning one into an agent has three honest outcomes:
//
//   certain     one agent answers — use it.
//   ambiguous   several do. ASK which. Picking the first, the nearest or the best-scoring is how money
//               reaches the wrong Alice, and no ranking makes that safe.
//   unknown     none does. ASK, and say where we looked.
//
// WHICH TIER, and why it changed. The first cut searched the PUBLIC directory, and that is wrong in a way
// that reads as helpful: a directory hit proves an agent EXISTS, never that this person knows them. Filling
// a payee from it means a stranger with a common label can be paid by a sentence that named a friend. Spec
// 352 §7 and 353 §3 are explicit — "Alice" resolves in the asker's PRIVATE tier or refuses, and a global
// people search is a different ask (279/338).
//
// So resolution now runs over `@agenticprimitives/context`: providers own a tier, the tier travels on every
// candidate, and a lookup that will bind an authority asks only the private ones. What remains public —
// `find_agents`, `get_agent` — answers QUESTIONS about who exists, which is a different thing a person can
// also want.
//
// The honest limit: the private tier reachable today is the asker's own relationships. Somebody known to
// them only through a shared org's roster is not found, and the person is asked rather than guessed at
// (spec 353 S3 / Ask-2 reaches rosters, which is a second private read against a different subject).
import { InputRequired, type InputFieldV1 } from '@agenticprimitives/orchestration';
import { resolveEntity, type EntityCandidate, type EntityProvider } from '@agenticprimitives/context';
import type { Address } from 'viem';
import { relationshipsProvider, rosterProvider } from './private-context.js';

/** The roots a bare label might live under, most-likely first. A person is the common case for "alice". */
export const PARTY_ROOTS = ['me', 'org', 'team', 'treasury', 'workspace', 'svc', 'circle', 'church', 'registry'] as const;

export interface PartyLookups {
  /** Exact name → address, from the naming service on chain. */
  resolveName?: (name: string) => Promise<string | null>;
  /** Read one record from a subject's own vault — the private tier. */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
}

const isAddress = (v: string): boolean => /^0[xX][0-9a-fA-F]{40}$/.test(v);

/**
 * A bare label against the typed roots the asker could plausibly mean, resolved on chain.
 *
 * PRIVATE tier, deliberately: `alice.me` is not a search of everyone — it is the question "does the person
 * I am acting for have an agent by this label", asked of a naming service that answers exactly. It is
 * paired with `relationships`, which knows who they actually know; between them, a bare label that matches
 * nothing they have a link to still surfaces if it is a well-known typed name, and ambiguity between the
 * two is a question rather than a pick.
 */
function typedRootProvider(resolveName: (name: string) => Promise<string | null>): EntityProvider {
  return {
    source: 'naming',
    tier: 'private',
    async candidates(query) {
      const label = query.term.trim().toLowerCase();
      if (isAddress(label)) return [];
      const names = label.includes('.') ? [label] : PARTY_ROOTS.map((r) => `${label}.${r}`);
      const found = await Promise.all(names.map(async (name) => ({ name, agent: await resolveName(name).catch(() => null) })));
      return found
        .filter((f): f is { name: string; agent: string } => !!f.agent)
        .map((f) => ({
          agent: f.agent.toLowerCase(),
          label: f.name,
          name: f.name,
          provenance: { tier: 'private' as const, source: 'naming', ...(query.subject ? { subject: query.subject } : {}), match: label.includes('.') ? 'exact-name' : 'label' },
        }));
    },
  };
}

/** The providers a party lookup may consult, in order — private ones only. */
export function partyProviders(lookups: PartyLookups): EntityProvider[] {
  const providers: EntityProvider[] = [];
  if (lookups.readSubjectRecord) {
    const tier = { readSubjectRecord: lookups.readSubjectRecord };
    // Own links first: an agent the person keeps a link to is more certainly "theirs" than one they merely
    // share a room with, and first-wins dedupe keeps that label when both find the same agent.
    providers.push(relationshipsProvider(tier), rosterProvider(tier));
  }
  if (lookups.resolveName) providers.push(typedRootProvider(lookups.resolveName));
  return providers;
}

/** Every agent the asker could mean by these words. Exported for tests and for a surface that wants to
 *  show the same candidates the resolver saw. */
export async function partyCandidates(raw: string, lookups: PartyLookups, subject?: string): Promise<EntityCandidate[]> {
  const outcome = await resolveEntity(partyProviders(lookups), { term: raw, tiers: ['private'], ...(subject ? { subject } : {}), limit: 8 });
  if (outcome.outcome === 'certain') return [outcome.candidate];
  return outcome.outcome === 'ambiguous' ? outcome.candidates : [];
}

/**
 * The address the person meant, or a question. `stepRef`/`toolId` place the question on the step that
 * needs it; `argName` is what a resume will answer; `subject` is WHOSE tier this is.
 */
export async function resolveParty(
  raw: unknown,
  lookups: PartyLookups,
  where: { stepRef: string; toolId: string; argName: string; what: string; subject?: string },
): Promise<Address> {
  const value = String(raw ?? '').trim();
  if (isAddress(value)) return value.toLowerCase() as Address;
  const ask = (prompt: string, field: InputFieldV1): never => {
    throw new InputRequired({ kind: 'data', stepRef: where.stepRef, toolId: where.toolId, prompt, fields: [field] });
  };
  if (!value) ask(`Who is ${where.what}?`, { name: where.argName, label: where.what, type: 'text', required: true, hint: 'an agent name (alice.me) or address' });

  const outcome = await resolveEntity(partyProviders(lookups), {
    term: value, tiers: ['private'], ...(where.subject ? { subject: where.subject } : {}), limit: 8,
  });
  if (outcome.outcome === 'certain') return outcome.candidate.agent.toLowerCase() as Address;
  if (outcome.outcome === 'unknown') {
    // Say where we looked. "I could not find them" without that leaves a person correcting the wrong thing.
    const said: Record<string, string> = {
    relationships: 'the agents you are linked to',
    roster: 'the members of your organizations',
    naming: 'the naming service',
  };
  const where_ = [...new Set(outcome.looked.map((l) => said[l.source] ?? l.source))].join(', ');
    ask(
      `I could not find “${value}”. Which agent do you mean?`,
      {
        name: where.argName, label: where.what, type: 'text', required: true,
        hint: `nothing in ${where_ || 'your own agents'} answers to “${value}” — give the full name (e.g. ${value}.me) or the address`,
      },
    );
  }
  // SEVERAL. Never pick: the person is the only one who knows which one they meant.
  const candidates = outcome.outcome === 'ambiguous' ? outcome.candidates : [];
  ask(`Which “${value}” do you mean?`, {
    name: where.argName, label: where.what, type: 'choice', required: true,
    choices: candidates.map((c) => ({ value: c.agent, label: c.label })),
    hint: `${candidates.length} agents you know answer to “${value}”`,
  });
  throw new Error('unreachable');
}
