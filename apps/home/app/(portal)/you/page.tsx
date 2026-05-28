'use client';
// "You" — the person agent (default context). Identity card + facts; profile is coming soon.
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { AgentIdentityCard } from '../../../src/components/portal/AgentIdentityCard';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { AddressChip } from '../../../src/components/shared/AddressChip';
import { UserIcon } from '../../../src/components/shared/Icons';

const EXPLORER = 'https://sepolia.basescan.org/address/';

export default function YouPage() {
  const { agentName, agentAddress, profile } = useSession();
  return (
    <SectionShell
      title="You"
      description={`This is you in the ${whitelabel.brand.community}. Your name is how others find and trust you; your address is your permanent identity.`}
    >
      <AgentIdentityCard
        size="hero"
        name={agentName ?? '—'}
        address={agentAddress ?? undefined}
        label={whitelabel.copy.portalYouLabel}
        explorerUrl={agentAddress ? EXPLORER + agentAddress : undefined}
      />

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your identity</h2>
        <dl className="identity-facts">
          <div><dt>Name</dt><dd>{agentName ?? '—'}</dd></div>
          <div><dt>Address</dt><dd>{agentAddress ? <AddressChip address={agentAddress} size="sm" /> : '—'}</dd></div>
          <div><dt>Community</dt><dd>{whitelabel.brand.community}</dd></div>
          <div><dt>Access</dt><dd>{profile?.access === 'standard' ? 'Standard' : 'Full access'}</dd></div>
        </dl>
      </div>

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Your profile</h2>
        <ComingSoonState
          icon={<UserIcon size={40} />}
          title="Your public profile"
          body={`Your bio, photo, and contact details for the ${whitelabel.brand.community} — shared on your terms.`}
        />
      </div>
    </SectionShell>
  );
}
