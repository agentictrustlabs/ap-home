'use client';
// THE BASIS LINE — spec 398 §4.4: "acting as ‹you› · in ‹Missio Nexus› · basis: custody". On every mutation screen
// and review card, the same two facts and the same words the switcher's caption uses (`actingBasis`). Optional third
// clause: what THIS act needs (describeRequirement's words) — the requirement, never a role name.
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { agentClassOf } from '../../lib/agent-class';
import { nameLabel } from '../../lib/domain';
import { parseWorkspacePath, type WorkspaceScope } from '../../lib/workspace';
import { actingBasis, type ActingBasis } from '../../lib/acting-basis';
import { BuildingIcon, LandmarkIcon, UserIcon } from '../shared/Icons';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const Icon = ({ kind }: { kind: ActingBasis['in']['kind'] }) => (kind === 'person' ? <UserIcon size={12} /> : kind === 'org' ? <BuildingIcon size={12} /> : <LandmarkIcon size={12} />);

/** Compute the basis for the ACTIVE workspace (or a given scope) from what the Home lists. */
export function useActingBasis(scope?: WorkspaceScope, delegationInHand?: boolean): ActingBasis | null {
  const { session, agentAddress, agentName, personName } = useSession();
  const pathname = usePathname();
  const { agents } = useManagedAgents(session?.token ?? null, 'any');
  return useMemo(() => {
    if (!agentAddress) return null;
    const active = scope ?? parseWorkspacePath(pathname ?? '/');
    const self = { address: agentAddress, ...(personName ? { name: personName } : agentName ? { name: nameLabel(agentName) } : {}) };
    return actingBasis({ active, self, agents: agents.map((a) => ({ agent: a.agent, kind: a.kind, ...(a.name ? { name: nameLabel(a.name) } : {}), ...(a.relationship ? { relationship: a.relationship } : {}) })), classOf: (k) => agentClassOf(k as Parameters<typeof agentClassOf>[0]), ...(delegationInHand !== undefined ? { delegationInHand } : {}) });
  }, [scope, pathname, agentAddress, agentName, personName, agents, delegationInHand]);
}

export function BasisLine({ scope, needs, delegationInHand, style }: { scope?: WorkspaceScope; /** what THIS act needs, in words (e.g. from describeRequirement) */ needs?: string; delegationInHand?: boolean; style?: React.CSSProperties }) {
  const b = useActingBasis(scope, delegationInHand);
  if (!b) return null;
  return (
    <div className="basis-line" data-testid="basis-line" data-basis={b.basis} style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.72rem', opacity: 0.85, ...(style ?? {}) }} title={b.words}>
      <span>acting as <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon kind={b.actingAs.kind} />{b.actingAs.name ?? short(b.actingAs.address)}</strong></span>
      {!b.same && <span>· in <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon kind={b.in.kind} />{b.in.name ?? short(b.in.address)}</strong></span>}
      {!b.same && <span>· basis: <strong>{b.basis === 'custody' ? 'custody' : b.basis === 'membership' ? 'membership grant' : b.basis === 'delegation' ? 'delegation in hand' : 'none'}</strong></span>}
      {needs && <span>· this act needs <strong>{needs}</strong></span>}
    </div>
  );
}
