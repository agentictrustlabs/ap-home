// PRINCIPAL ≠ WORKSPACE CONTEXT, MADE VISIBLE — spec 398 §4.4. Every mutation screen and review card shows two facts
// side by side: ACTING AS (the principal SA, with its class) and IN (the workspace context). When the two differ
// ("you, in Missio Nexus") the card says on what BASIS the act may proceed: custody · a membership grant · a delegation
// in hand — or none. A role name ("researcher") is a responsibility (344), never a basis. Pure: the words are derived
// from what the Home already knows (the managed-agent list's relationship, the workspace path); nothing here is
// authority — the verifier decides on chain, this only says what the person is standing on.
import type { WorkspaceScope } from './workspace';

export type AgentClass = 'person' | 'org' | 'service';
export type Basis = 'self' | 'custody' | 'membership' | 'delegation' | 'none';

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
    return { actingAs: me, in: me, same: true, basis: 'self', caption: 'acting as you', words: 'your own agent — your credential signs' };
  }
  const address = lc(input.active.kind === 'org' ? input.active.org : input.active.agent);
  const known = input.agents.find((a) => lc(a.agent) === address);
  const kind: AgentClass = known ? input.classOf(known.kind) : input.active.kind === 'org' ? 'org' : 'service';
  const ctx = { address, ...(known?.name ? { name: known.name } : {}), kind };
  if (known && known.relationship !== 'member') {
    return { actingAs: me, in: ctx, same: false, basis: 'custody', caption: 'acting as custodian', words: 'you custody this agent — your credential signs for it' };
  }
  if (known?.relationship === 'member') {
    return { actingAs: me, in: ctx, same: false, basis: 'membership', caption: 'member · no custody', words: 'a membership grant — you may take part; an act as this agent needs a steward' };
  }
  if (input.delegationInHand) {
    return { actingAs: me, in: ctx, same: false, basis: 'delegation', caption: 'delegated · no custody', words: 'a delegation in hand — scoped to what it names, revocable on chain' };
  }
  return { actingAs: me, in: ctx, same: false, basis: 'none', caption: 'visiting · no custody', words: 'no standing here — you can look, not act' };
}
