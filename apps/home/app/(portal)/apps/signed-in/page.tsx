'use client';
// Connected → Apps you signed into (spec 422 §8). The apps that used this home to sign the person in, as this device
// remembers them. Signing in gave them identity, not access: what any app may READ is a separate grant on the readers
// page, and that is where it is removed.
import { useEffect, useState } from 'react';
import { useSession } from '../../../../src/context/session';
import { listConnectedApps } from '../../../../src/lib/connected-apps';
import type { Permission } from '../../../../src/home/types';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { ConnectedAppCard } from '../../../../src/components/portal/ConnectedAppCard';
import { GlobeIcon } from '../../../../src/components/shared/Icons';
import { Note, EmptyState } from '../../../../src/ui';
import '../../../../src/components/portal/developer-apps.css';

export default function SignedInAppsPage() {
  const { agentAddress } = useSession();
  const [apps, setApps] = useState<Permission[] | null>(null);
  useEffect(() => { if (agentAddress) setApps(listConnectedApps(agentAddress)); }, [agentAddress]);
  return (
    <SectionShell title="Apps you signed into" description="Apps that used this home to sign you in — what each was told it may and may not do.">
      <Note>Signing in proves <b>who you are</b> to an app. It gives the app no standing access to your records: what any app may read is a separate yes, listed under <a href="/apps/readers">Who can read your records</a>, and that is where you take it back. This list is what <b>this device</b> remembers; the record of what you authorized is on chain.</Note>
      {apps === null ? null : apps.length === 0 ? (
        <EmptyState icon={<GlobeIcon size={32} />} title="No app has signed you in from this device yet" hint="When one does, it appears here with what it was told it may and may not do." />
      ) : apps.map((a) => <ConnectedAppCard key={a.clientId} app={a} />)}
    </SectionShell>
  );
}
