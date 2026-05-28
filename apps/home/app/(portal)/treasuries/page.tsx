import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { LandmarkIcon } from '../../../src/components/shared/Icons';

export default function TreasuriesPage() {
  const a = whitelabel.manageableAgents.find((x) => x.id === 'treasury');
  return (
    <SectionShell
      title={a?.label ?? 'Treasuries'}
      status={a?.status === 'live' ? 'live' : 'soon'}
      comingSoon={{
        icon: <LandmarkIcon size={40} />,
        title: a?.label ?? 'Treasuries',
        body: `${a?.blurb ?? 'Funds and giving your agents steward'} — stewarded transparently, on your terms.`,
      }}
    />
  );
}
