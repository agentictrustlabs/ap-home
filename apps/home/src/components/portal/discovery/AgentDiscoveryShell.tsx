'use client';
// One guard for every agent-scoped Discovery page, org-class and service-class alike: resolve the agent
// in the URL to a managed agent the signed-in person actually holds, hand its address AND its name to the
// panel, and say plainly when it resolves to nothing. Mirrors the Studio's `Guarded` — same three failure
// sentences, so a workspace and an organization behave the same way on the same question.
//
// The class is a parameter rather than two components because the QUESTIONS are identical: an org and a
// service are both Smart Agents, and "is it registered / what is it named / what can it do" does not
// change between them (ADR-0046). Only which class may be addressed at this route differs, so that a
// /service URL cannot quietly render an organization or the reverse.
import { SkeletonRows } from '../../../ui';
import type { ReactNode } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { useManagedAgents } from '../ManagedAgents';
import type { AgentKind } from '../../../connect-client';
import { agentClassOf } from '../../../lib/agent-class';

const lc = (s: string) => s.toLowerCase();

export function AgentDiscoveryShell({
  agent,
  cls,
  title,
  children,
}: {
  agent: string;
  /** Which ADR-0046 class this route serves; an address of the other class is not found here. */
  cls: 'org' | 'service';
  title: string;
  /** Rendered with the resolved address, the agent's on-chain name (`null` when it has none), and its
   *  KIND — which typed suffix an agent may claim follows from its type, not from its route. */
  children(a: Address, name: string | null, kind: AgentKind): ReactNode;
}) {
  const { session } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');

  if (!session) return <SectionShell title={title}><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title={title}><SkeletonRows rows={3} /></SectionShell>;

  const found = agents.find((a) => agentClassOf(a.kind) === cls && lc(a.agent) === lc(agent));
  if (!found) {
    return (
      <SectionShell title={title}>
        <p className="manage-card-blurb">
          You don&rsquo;t manage {cls === 'org' ? 'an organization' : 'a service agent'} at this address.
        </p>
      </SectionShell>
    );
  }
  return <SectionShell title={title}>{children(found.agent as Address, found.name || null, found.kind)}</SectionShell>;
}
