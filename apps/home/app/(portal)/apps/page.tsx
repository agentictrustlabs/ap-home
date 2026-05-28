'use client';
// Connected Apps — the grants this portal has issued (control made visible). Revoke is
// custody-grade → "coming soon" (Step-7/security follow-up), never faked.
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { listConnectedApps, type ConnectedAppRecord } from '../../../src/lib/connected-apps';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { ConnectedAppCard } from '../../../src/components/portal/ConnectedAppCard';
import { LinkIcon } from '../../../src/components/shared/Icons';

export default function AppsPage() {
  const { agentAddress } = useSession();
  const [apps, setApps] = useState<ConnectedAppRecord[]>([]);
  useEffect(() => {
    if (agentAddress) setApps(listConnectedApps(agentAddress));
  }, [agentAddress]);

  return (
    <SectionShell
      title="Connected Apps"
      description={`Apps you've authorized to act on your behalf in the ${whitelabel.brand.community}. See exactly what each can do.`}
    >
      {apps.length === 0 ? (
        <ComingSoonState
          icon={<LinkIcon size={40} />}
          title="No apps connected yet"
          body="Apps you authorize will appear here — you'll always see what each can do and stay in control."
        />
      ) : (
        <>
          {apps.map((a) => (
            <ConnectedAppCard key={a.clientId} app={a} />
          ))}
          <p className="muted footnote">
            This reflects apps you&apos;ve connected from this portal on this device. Your canonical access record lives on-chain.
          </p>
        </>
      )}
    </SectionShell>
  );
}
