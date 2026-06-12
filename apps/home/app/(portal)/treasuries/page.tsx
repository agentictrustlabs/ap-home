'use client';
// Treasuries — every treasury you control in one place (spec 275): your personal treasury + each
// organization's treasury. On-chain Smart Agents, named, custodied by you. Create your personal
// treasury here; org treasuries are created from their organization in /organizations.
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { TreasuriesRollup } from '../../../src/components/portal/ManagedAgents';

export default function TreasuriesPage() {
  const { session, agentAddress } = useSession();
  const a = whitelabel.manageableAgents.find((x) => x.id === 'treasury');
  return (
    <SectionShell
      title={a?.label ?? 'Treasuries'}
      description={`${a?.blurb ?? 'Funds and giving your agents steward'} — stewarded transparently, on your terms.`}
    >
      <TreasuriesRollup token={session?.token ?? null} person={agentAddress ?? null} via={session?.via ?? ''} />
    </SectionShell>
  );
}
