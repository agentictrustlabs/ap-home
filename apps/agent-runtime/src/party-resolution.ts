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
import { VALUE_ARGS as ONTOLOGY_VALUE_ARGS } from '@agenticprimitives/ontology';
import { relationshipRows } from './relationship-rows.js';
import { RESOLUTION_GRANTS_RECORD, usableGrants } from './resolution-invitation.js';
import { relationshipsProvider, rosterProvider } from './private-context.js';

/** The roots a bare label might live under, most-likely first. A person is the common case for "alice". */
export const PARTY_ROOTS = ['me', 'org', 'team', 'treasury', 'workspace', 'svc', 'circle', 'church', 'registry'] as const;

export interface PartyLookups {
  /** Exact name → address, from the naming service on chain. */
  resolveName?: (name: string) => Promise<string | null>;
  /** Read one record from a subject's own vault — the private tier. */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** Told what a party's words RESOLVED TO, so a surface can show it back before anyone signs. The
   *  resolver is the only place that knows both halves — "nathan" and the address it became — and by the
   *  time an argument reaches a mandate the words are gone. Display only; it decides nothing. */
  onResolved?: (r: ResolvedParty) => void;
  /** The agents chartered under `owner` of a given type, read from the on-chain `ap:charteredUnder`
   *  edges (spec 355 W2). PUBLIC: this is the half that answers for someone else's agents. */
  charteredAgents?: (owner: string, type: string) => Promise<Array<{ agent: string; name?: string }>>;
}

/** What one party's words became. `label` is absent when the person gave an address outright — there was
 *  nothing to resolve, and inventing a name for it would be the surface claiming knowledge it lacks. */
export interface ResolvedParty {
  arg: string;
  raw: string;
  agent: string;
  label?: string;
  hint?: string;
}

const isAddress = (v: string): boolean => /^0[xX][0-9a-fA-F]{40}$/.test(v);

/** Arguments that move value — from the ontology binding (spec 355), where a party says whether getting
 *  it wrong can be undone. For these, settling for a different KIND of agent than the capability asked
 *  for is a question, not a resolution: a payment cannot be taken back. */
const VALUE_ARGS = ONTOLOGY_VALUE_ARGS;

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
 * THE ASKER'S OWN AGENT OF A GIVEN TYPE — "pay from my treasury", without them having to say it.
 *
 * A person standing in their own realm says "send alice 20 USDC" and means the thing of theirs that holds
 * money. What arrives is their PERSON address, because that is the realm they are standing in, and a
 * person SA holds no USDC — so the ask died on a balance check against an account that was never meant to
 * pay. The typed suffix already says which of their agents is the payer; this is that lookup, over their
 * own tree only.
 *
 * Their own tier, and no widening: this answers "which of YOUR agents", never "which agent anywhere".
 */
export async function ownAgentsOfType(
  subject: string,
  type: string,
  lookups: PartyLookups,
): Promise<EntityCandidate[]> {
  if (!lookups.readSubjectRecord) return [];
  const doc = await lookups.readSubjectRecord(subject, 'relationships.data');
  return relationshipRows(doc).filter((r) => isOfType(r, type)).map((r) => asCandidate(r, type, subject, 'own-agent'));
}

/**
 * Is this one of the person's agents of that kind?
 *
 * THE NAME IS NOT THE ONLY EVIDENCE, and relying on it lost seven treasuries. An UNNAMED agent has no
 * suffix to read — that is the whole point of being unnamed — so its row's `kind` (`person-treasury`,
 * `org-treasury`) is what says what it is. Reading only the suffix meant a person who had created every
 * treasury without a name owned, as far as this resolver could tell, none at all.
 */
function isOfType(r: { name: string; kind?: string }, type: string): boolean {
  if (r.name.toLowerCase().split('.').pop() === type) return true;
  const kind = (r.kind ?? '').toLowerCase();
  return kind === type || kind.endsWith(`-${type}`);
}

/** A row as a candidate. An unnamed agent is labelled by WHAT it is, since it has nothing else. */
function asCandidate(r: { agent: string; name: string; kind?: string }, type: string, subject: string, match: string): EntityCandidate {
  const named = r.name.includes('.');
  return {
    agent: r.agent,
    label: named ? r.name : `unnamed ${type} · ${r.agent.slice(0, 8)}…${r.agent.slice(-4)}`,
    ...(named ? { name: r.name } : {}),
    provenance: { tier: 'private' as const, source: 'relationships', subject, match },
  };
}

/**
 * THE AGENTS SOMEONE OWNS, of a given type — the relationship, not the name.
 *
 * "Send money to alice" means alice's TREASURY. Finding it by guessing the name `alice.treasury` was
 * wrong in principle and wrong in fact: her treasury is called `alice2.treasury`, and a treasury's name
 * has no obligation to resemble its owner's. What actually connects them is the OWNERSHIP relationship —
 * resolve the person first, then ask what they hold.
 *
 * Read from the asker's own tree, where an agent records its parent. That covers everything they are
 * linked to — their own treasuries, and those of the organizations they steward. It does NOT cover a
 * stranger's: the link between alice.me and alice2.treasury lives in ALICE's private records
 * (ADR-0025), and is in no public place today — not the relationship registry (no edges exist), not the
 * directory (no owner field), not the naming service (whose "parent" is the TLD). Until a person's
 * treasury is a public fact, nobody else can be routed to it, and the honest move is to ask.
 */
export async function ownedAgentsOfType(
  owner: string,
  type: string,
  lookups: PartyLookups,
  asker?: string,
): Promise<EntityCandidate[]> {
  const subject = asker ?? owner;
  const low = owner.toLowerCase();
  const seen = new Set<string>();
  const out: EntityCandidate[] = [];

  // ON CHAIN FIRST (spec 355 W2): `ap:charteredUnder` edges are PUBLIC and chain-reproducible, so this is
  // the half that works for a stranger — Nathan can be routed to Alice's treasury without reading
  // anything of hers. Not a fallback chain: both sources answer the same question ("what does this agent
  // hold of this kind"), and the CALLER decides what to do with one answer or several.
  for (const c of await (lookups.charteredAgents?.(low, type) ?? Promise.resolve([])).catch(() => [])) {
    if (seen.has(c.agent)) continue;
    seen.add(c.agent);
    out.push({
      agent: c.agent, label: c.name ?? c.agent, ...(c.name ? { name: c.name } : {}),
      provenance: { tier: 'public' as const, source: 'chartered-under', subject: low, match: 'owned-by' },
    });
  }

  // A GRANT SOMEONE GAVE THEM. An unlisted agent is in no public place by its owner's choice, so the only
  // way to reach it is that the owner told this person — a resolution grant they hold in their own vault
  // (spec 338 / ADR-0056). It answers "where do I send it", never "may I spend it": the payment that
  // follows still needs the asker's own mandate, judged by the verifier like any other.
  if (lookups.readSubjectRecord && asker) {
    const held = await lookups.readSubjectRecord(asker, RESOLUTION_GRANTS_RECORD).catch(() => null);
    for (const g of usableGrants(held, type)) {
      if (g.owner.toLowerCase() !== low || seen.has(g.targetAgent.toLowerCase())) continue;
      seen.add(g.targetAgent.toLowerCase());
      out.push({
        agent: g.targetAgent.toLowerCase(),
        // It has NO NAME — that is why a grant was needed. Say whose it is instead.
        // "alice.me's treasury" — the owner's name, because the target has none and an address alone
        // does not tell the holder who they are about to pay.
        label: g.label ?? (g.ownerName ? `${g.ownerName}'s ${type}` : `their ${type}`),
        provenance: { tier: 'private' as const, source: 'resolution-grant', subject: asker, match: 'granted' },
      });
    }
  }

  // Then the asker's own tier, which knows agents whose edge has not been recorded yet — every agent
  // created before W2, and any whose owner chose not to publish the link.
  if (lookups.readSubjectRecord) {
    const doc = await lookups.readSubjectRecord(subject, 'relationships.data').catch(() => null);
    for (const r of relationshipRows(doc)) {
      if (r.parent?.toLowerCase() !== low || !isOfType(r, type) || seen.has(r.agent)) continue;
      seen.add(r.agent);
      out.push(asCandidate(r, type, subject, 'owned-by'));
    }
  }
  return out;
}

/** Where a candidate came from, said the way a person would say it. */
const FOUND_IN: Record<string, string> = {
  relationships: 'you are linked to them',
  roster: 'a member of one of your organizations',
  naming: 'the naming service',
};

/**
 * What tells two agents with the same name apart. Kind first (a person and a team called the same thing
 * is the common case), then the address — truncated, because the middle of an address distinguishes
 * nothing and a full one crowds out the parts that do.
 */
export function candidateHint(c: EntityCandidate): string {
  const bits: string[] = [];
  if (c.name && c.name !== c.label) bits.push(c.name);
  if (c.kind) bits.push(c.kind);
  bits.push(`${c.agent.slice(0, 8)}…${c.agent.slice(-4)}`);
  const from = FOUND_IN[c.provenance.source];
  if (from) bits.push(from);
  return bits.join(' · ');
}

/**
 * The address the person meant, or a question. `stepRef`/`toolId` place the question on the step that
 * needs it; `argName` is what a resume will answer; `subject` is WHOSE tier this is.
 */
export async function resolveParty(
  raw: unknown,
  lookups: PartyLookups,
  where: { stepRef: string; toolId: string; argName: string; what: string; subject?: string; types?: readonly string[]; pendingAmount?: string },
): Promise<Address> {
  const value = String(raw ?? '').trim();
  if (isAddress(value)) {
    lookups.onResolved?.({ arg: where.argName, raw: value, agent: value.toLowerCase() });
    return value.toLowerCase() as Address;
  }
  const ask = (prompt: string, field: InputFieldV1, suggest?: { label: string; message: string }): never => {
    throw new InputRequired({ kind: 'data', stepRef: where.stepRef, toolId: where.toolId, prompt, fields: [field], ...(suggest ? { suggest } : {}) });
  };
  if (!value) ask(`Who is ${where.what}?`, { name: where.argName, label: where.what, type: 'text', required: true, hint: 'an agent name (alice.me) or address' });

  const outcome = await resolveEntity(partyProviders(lookups), {
    term: value, tiers: ['private'], ...(where.subject ? { subject: where.subject } : {}), limit: 8,
  });
  // ── WHAT KIND OF AGENT THIS ARGUMENT IS ──────────────────────────────────────────────────────────
  // "Send money to nathan" and "send nathan a message" are the same word; the difference lives in the
  // CAPABILITY, and the typed suffix (ADR-0061) is what makes it decidable. Tiers, in the order a person
  // means them: the first type anything answers to wins.
  //
  // This narrows and never picks. Two treasuries called nathan is still a question, and a capability whose
  // preferred types match nothing gets asked with everything that DID answer — "nathan has no treasury"
  // is an answer, not a licence to quietly pay some other Nathan.
  if (where.types?.length && (outcome.outcome === 'ambiguous' || outcome.outcome === 'certain')) {
    const all = outcome.outcome === 'ambiguous' ? outcome.candidates : [outcome.candidate];
    const suffix = (c: EntityCandidate) => (c.name ?? c.label ?? '').toLowerCase().split('.').pop() ?? '';
    for (const [rank, type] of where.types.entries()) {
      const tier = all.filter((c) => suffix(c) === type);
      // A SUBSTITUTION IS NOT A RESOLUTION. "Send alice 20 USDC" asks for her treasury; when nothing
      // answers to one, paying her PERSON agent instead is a different destination reached silently — and
      // a payment to the wrong address is not a thing anyone can undo. So for arguments that move value,
      // dropping past the first-choice type is a question, with the reason said plainly.
      //
      // Only for money: a message falling from `.me` to `.org` is the same conversation with the same
      // person's organization, and asking about it would be noise.
      // NOT OF THIS TYPE — so ask what the ones we DID find OWN. "Send money to alice" names the person;
      // her treasury is a thing she HOLDS, and the two are connected by a relationship, not by their
      // names resembling each other. Resolve the person, then follow the link.
      if (!tier.length && rank === 0) {
        const owned = (await Promise.all(all.map((c) => ownedAgentsOfType(c.agent, type, lookups, where.subject).catch(() => []))))
          .flat()
          .filter((c, i, xs) => xs.findIndex((y) => y.agent === c.agent) === i);
        if (owned.length === 1) {
          const c = owned[0]!;
          lookups.onResolved?.({ arg: where.argName, raw: value, agent: c.agent, label: c.label, hint: candidateHint(c) });
          return c.agent.toLowerCase() as Address;
        }
        if (owned.length > 1) {
          // Several of theirs. Which one is theirs to say — a person may hold more than one treasury and
          // nothing about the ask distinguishes them.
          ask(`Which ${type} should be ${where.what}?`, {
            name: where.argName, label: where.what, type: 'choice', required: true,
            choices: owned.map((c) => ({ value: c.agent, label: c.label, hint: candidateHint(c) })),
            allowOther: true,
            hint: `“${value}” holds ${owned.length} ${type}s — pick the one you mean`,
          });
        }
      }
      if (tier.length && rank > 0 && VALUE_ARGS.has(where.argName)) {
        ask(`Nothing called “${value}” is a ${where.types[0]}. Who should be ${where.what}?`, {
          name: where.argName, label: where.what, type: 'choice', required: true,
          choices: all.map((c) => ({ value: c.agent, label: c.label, hint: candidateHint(c) })),
          // The right answer is very often NOT in this list — that is the whole reason we are asking —
          // so the person must be able to type it. Telling them to "give it in full" beside a list they
          // cannot add to is a dead end with instructions on it.
          allowOther: true,
          hint: `a ${where.types[0]} may exist under another name — give it in full (e.g. ${value}2.${where.types[0]}) to send there instead`,
        }, {
          // THE WAY OUT OF THE DEAD END. Their ${where.types[0]} may exist and simply be unlisted — that
          // is a choice its owner made, and the answer is to ask them, not to guess harder. Offered as a
          // follow-up the person can send, because they should not have to know the phrasing.
          //
          // It carries the AMOUNT when the ask named one, so the request records what this was for and
          // the payment can be finished in one press when the answer comes back. Without it the person
          // has to remember, days later, what they were trying to send and to whom.
          label: `Ask ${value} for a way to reach their ${where.types[0]}`,
          message: where.pendingAmount
            ? `ask ${value} for a way to pay their ${where.types[0]} so I can send ${where.pendingAmount} usdc`
            : `ask ${value} for a way to pay their ${where.types[0]}`,
        });
      }
      if (tier.length === 1) {
        const c = tier[0]!;
        lookups.onResolved?.({ arg: where.argName, raw: value, agent: c.agent.toLowerCase(), label: c.label, hint: candidateHint(c) });
        return c.agent.toLowerCase() as Address;
      }
      if (tier.length > 1) {
        ask(`Which “${value}” do you mean?`, {
          name: where.argName, label: where.what, type: 'choice', required: true,
          choices: tier.map((c) => ({ value: c.agent, label: c.label, hint: candidateHint(c) })),
          allowOther: true,
          hint: `${tier.length} of them are what ${where.what} has to be — pick one, or give a full name`,
        });
      }
    }
  }
  if (outcome.outcome === 'certain') {
    // ONE match is still a decision, and the person never made it. Report what "nathan" became so the
    // surface can show it before a signature, rather than after — a certain resolution is the case where
    // nobody is asked anything, which is exactly when a wrong one goes unnoticed.
    const c = outcome.candidate;
    lookups.onResolved?.({ arg: where.argName, raw: value, agent: c.agent.toLowerCase(), label: c.label, hint: candidateHint(c) });
    return c.agent.toLowerCase() as Address;
  }
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
  //
  // And a list of four things all called "Nathan" is not a choice. Each one carries what tells it APART —
  // its full name, what KIND of agent it is, its address, and WHERE we know it from — because the person
  // is about to authorize something against one of them, and "the second Nathan" is not a thing anyone
  // knows about themselves. There is deliberately no default and no highlighted best: ranking these would
  // need a score, and a score is the thing this resolver refuses to invent (spec 353 §3, ADR-0013).
  const candidates = outcome.outcome === 'ambiguous' ? outcome.candidates : [];
  // Nothing of the RIGHT KIND, when a kind was asked for: say so, and show what does exist. A person who
  // hears "nathan has no treasury" knows what to do next; one who is silently offered nathan.me for a
  // payment does not.
  const wanted = where.types?.length ? `nothing called “${value}” is ${where.types[0] === 'me' ? 'a person' : `a ${where.types[0]}`} — ` : '';
  ask(`Which “${value}” do you mean?`, {
    name: where.argName, label: where.what, type: 'choice', required: true,
    choices: candidates.map((c) => ({ value: c.agent, label: c.label, hint: candidateHint(c) })),
    // Someone they know may not be among these, and knowing the full name is a real answer.
    allowOther: true,
    hint: `${wanted}${candidates.length} agents you know answer to “${value}” — pick one, or give a full name`,
  });
  throw new Error('unreachable');
}
