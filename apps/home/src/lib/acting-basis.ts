// PRINCIPAL ≠ WORKSPACE CONTEXT, MADE VISIBLE — spec 398 §4.4. Every mutation screen and review card shows two facts
// side by side: ACTING AS (the principal SA, with its class) and IN (the workspace context). When the two differ
// ("you, in Missio Nexus") the card says on what BASIS the act may proceed: stewardship · a membership grant · a
// delegation in hand — or none. THE WORD IS STEWARDSHIP, NOT CUSTODY (agent-vocabulary.md R.2): the relation a person
// has to an organization she created is the stewardship grant it signed to her; custody is her KEY's relation to an
// address, and on a Google-custodied home that key is one she has never seen. "Custodian" belongs on Security only. A role name ("researcher") is a responsibility (344), never a basis. Pure: the words are derived
// from what the Home already knows (the managed-agent list's relationship, the workspace path); nothing here is
// authority — the verifier decides on chain, this only says what the person is standing on.
import type { WorkspaceScope } from './workspace';
import { BASIS_CAPTION } from '@agenticprimitives/ontology/participant-vocabulary';

export type AgentClass = 'person' | 'org' | 'service';
export type Basis = 'self' | 'stewardship' | 'membership' | 'delegation' | 'none';

export interface ActingBasis {
  actingAs: { address: string; name?: string; kind: AgentClass };
  in: { address: string; name?: string; kind: AgentClass };
  /** Whether the principal and the context are one and the same agent. */
  same: boolean;
  basis: Basis;
  /** The caption the switcher shows — the same words on every surface. */
  caption: string;
  /** The basis in a sentence, for the card. */
  words: string;
}

export interface KnownAgent { agent: string; name?: string; kind: string; relationship?: string }

const lc = (s: string) => s.toLowerCase();

export function actingBasis(input: {
  active: WorkspaceScope;
  self: { address: string; name?: string };
  /** The agents the Home lists for this person (stewarded and member orgs, services), with their relationship. */
  agents: ReadonlyArray<KnownAgent>;
  classOf: (kind: string) => AgentClass;
  /** A delegation in hand for the context — when a surface knows one (an org's stewardship wire, a received grant). */
  delegationInHand?: boolean;
}): ActingBasis {
  const me = { address: lc(input.self.address), ...(input.self.name ? { name: input.self.name } : {}), kind: 'person' as const };
  if (input.active.kind === 'person') {
    return { actingAs: me, in: me, same: true, basis: 'self', caption: BASIS_CAPTION.self, words: 'you, on your own agent — your key signs' };
  }
  /**
   * A PERSONA IS NOT "YOU, IN SOMETHING" — it is you under another of your names, so the PRINCIPAL is the
   * persona, not the connected person standing inside it. That is the whole difference from an org: there is
   * no second party and no grant between you and yourself, which is why the basis is `self` and `same` is
   * true. Only the NAME changes, and the name is the point — so the caption says which one, where an org's
   * says on what authority.
   */
  if (input.active.kind === 'persona') {
    const a = lc(input.active.agent);
    const row = input.agents.find((x) => lc(x.agent) === a);
    const as = { address: a, ...(row?.name ? { name: row.name } : {}), kind: 'person' as const };
    return {
      actingAs: as, in: as, same: true, basis: 'self',
      caption: BASIS_CAPTION.persona(row?.name),
      words: 'another name of yours — the same key signs, under a different name, into its own vault',
    };
  }
  const address = lc(input.active.kind === 'org' ? input.active.org : input.active.agent);
  const known = input.agents.find((a) => lc(a.agent) === address);
  const kind: AgentClass = known ? input.classOf(known.kind) : input.active.kind === 'org' ? 'org' : 'service';
  const ctx = { address, ...(known?.name ? { name: known.name } : {}), kind };
  if (known && known.relationship !== 'member') {
    return { actingAs: me, in: ctx, same: false, basis: 'stewardship', caption: BASIS_CAPTION.stewardship(ctx.name), words: 'you steward this agent — its stewardship grant names you; your key signs for it' };
  }
  if (known?.relationship === 'member') {
    return { actingAs: me, in: ctx, same: false, basis: 'membership', caption: BASIS_CAPTION.membership, words: 'a membership grant — you may take part; an act as this agent needs a steward' };
  }
  if (input.delegationInHand) {
    return { actingAs: me, in: ctx, same: false, basis: 'delegation', caption: BASIS_CAPTION.delegation, words: 'a delegation in hand — scoped to what it names, revocable on chain' };
  }
  return { actingAs: me, in: ctx, same: false, basis: 'none', caption: BASIS_CAPTION.none, words: 'no standing here — you can look, not act' };
}
