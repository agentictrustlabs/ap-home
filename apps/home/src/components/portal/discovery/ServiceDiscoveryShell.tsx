'use client';
// One guard for every workspace Discovery page: resolve the agent in the URL to a managed agent the
// signed-in person actually holds, hand its address AND its name to the panel, and say plainly when it
// resolves to nothing. Mirrors the Studio's `Guarded` — same three failure sentences, so a workspace
// behaves the same whichever surface you are on.
import type { ReactNode } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { SectionShell } from '../SectionShell';
import { useManagedAgents } from '../ManagedAgents';
import { agentClassOf } from '../../../lib/agent-class';

const lc = (s: string) => s.toLowerCase();

export function ServiceDiscoveryShell({
  agent,
  title,
  children,
}: {
  agent: string;
  title: string;
  /** Rendered with the resolved address and the agent's on-chain name (`null` when it has none). */
  children(a: Address, name: string | null): ReactNode;
}) {
  const { session } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null, 'any');

  if (!session) return <SectionShell title={title}><p>Not signed in.</p></SectionShell>;
  if (!loaded) return <SectionShell title={title}><p className="manage-card-blurb">Loading…</p></SectionShell>;

  const found = agents.find((a) => agentClassOf(a.kind) === 'service' && lc(a.agent) === lc(agent));
  if (!found) {
    return (
      <SectionShell title={title}>
        <p className="manage-card-blurb">You don&rsquo;t manage an agent at this address.</p>
      </SectionShell>
    );
  }
  return <SectionShell title={title}>{children(found.agent as Address, found.name || null)}</SectionShell>;
}
