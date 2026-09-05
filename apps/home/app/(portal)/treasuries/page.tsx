'use client';
// Treasuries — every treasury you control in one place (spec 275): your personal treasury + each
// organization's treasury. On-chain Smart Agents, named, custodied by you. Create your personal
// treasury here; org treasuries are created from their organization in /organizations.
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { TreasuriesRollup } from '../../../src/components/portal/ManagedAgents';
import { ResolutionRequests } from '../../../src/components/portal/ResolutionRequests';
import { ReadyToSend } from '../../../src/components/portal/ReadyToSend';

export default function TreasuriesPage() {
  const { session, agentAddress } = useSession();
  const a = whitelabel.manageableAgents.find((x) => x.id === 'treasury');
  return (
    <SectionShell
      title={a?.label ?? 'Treasuries'}
      description={`${a?.blurb ?? 'Funds and giving your agents steward'} — stewarded transparently, on your terms.`}
    >
      {/* Decisions before inventory: someone waiting on a way to pay you belongs above the list of what
          you hold, and an unnamed treasury is unreachable until you answer them (spec 338 §7). */}
      <ResolutionRequests />
      {/* The other end of the same exchange: someone answered, and this is where you finish what you
          started. Above the inventory for the same reason — it is a thing waiting on you. */}
      <ReadyToSend />
      <TreasuriesRollup token={session?.token ?? null} person={agentAddress ?? null} via={session?.via ?? ''} />
    </SectionShell>
  );
}
