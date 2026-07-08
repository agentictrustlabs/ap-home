'use client';
// App workspace — Overview (spec 315). The grant surface for ONE connected app the custodian
// authorized: what it can and cannot do. Reuses the Connected Apps card.
import { use, useEffect, useState } from 'react';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { ConnectedAppCard } from '../../../../src/components/portal/ConnectedAppCard';
import { listConnectedApps } from '../../../../src/lib/connected-apps';
import type { Permission } from '../../../../src/home/types';

export default function AppWorkspacePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  const { session, agentAddress } = useSession();
  const [app, setApp] = useState<Permission | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!agentAddress) return;
    setApp(listConnectedApps(agentAddress).find((a) => a.clientId === clientId) ?? null);
    setLoaded(true);
  }, [agentAddress, clientId]);

  if (!session) return <SectionShell title="Connected app"><p>Not signed in.</p></SectionShell>;

  return (
    <SectionShell title={app?.appName ?? 'Connected app'}>
      {!loaded ? (
        <p className="manage-card-blurb">Loading…</p>
      ) : !app ? (
        <p className="manage-card-blurb">No grant record for this app on this device.</p>
      ) : (
        <ConnectedAppCard app={app} />
      )}
    </SectionShell>
  );
}
