import { whitelabel } from '../../../src/whitelabel/config';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { DatabaseIcon } from '../../../src/components/shared/Icons';

export default function DataSourcesPage() {
  const a = whitelabel.manageableAgents.find((x) => x.id === 'data-source');
  return (
    <SectionShell
      title={a?.label ?? 'Data sources'}
      status={a?.status === 'live' ? 'live' : 'soon'}
      comingSoon={{
        icon: <DatabaseIcon size={40} />,
        title: a?.label ?? 'Data sources',
        body: `${a?.blurb ?? 'Records and feeds you can share, with your consent'} — you decide who sees what.`,
      }}
    />
  );
}
