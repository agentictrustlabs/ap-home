'use client';
// Connected Apps — the grants this portal has issued (control made visible). Revoke is
// custody-grade → "coming soon" (Step-7/security follow-up), never faked.
import { useEffect, useState } from 'react';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { listConnectedApps } from '../../../src/lib/connected-apps';
import type { Permission } from '../../../src/home/types';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { ConnectedAppCard } from '../../../src/components/portal/ConnectedAppCard';
import { YouVersionData } from '../../../src/components/portal/YouVersionData';
import { ConnectorCard } from '../../../src/components/portal/CalendarConnectCard';
import { HomeManifestCard } from '../../../src/components/portal/HomeManifestCard';
import { DirectoryListingCard } from '../../../src/components/portal/DirectoryListingCard';
import { AppReadGrants } from '../../../src/components/portal/AppReadGrants';
import { AppGrantsPanel } from '../../../src/components/portal/AppGrantsPanel';
import '../../../src/components/portal/developer-apps.css';
import { LinkIcon } from '../../../src/components/shared/Icons';

export default function AppsPage() {
  const { agentAddress } = useSession();
  const [apps, setApps] = useState<Permission[]>([]);
  useEffect(() => {
    if (agentAddress) setApps(listConnectedApps(agentAddress));
  }, [agentAddress]);

  return (
    <SectionShell
      title="Connected"
      description={`Your connected accounts (what your agent may read through) and connected apps (clients of you in the ${whitelabel.brand.community}) — what each can do, and where to revoke it.`}
    >
      {/* agent-vocabulary.md §2 — CONNECTION is one relation with two shapes: an APP that is a client of you (a relying app,
          an assistant holding your wire) and an ACCOUNT of yours your agent may read through (a connector). Two panels,
          one page; neither is a participant. */}
      <h2 className="ui-h2" style={{ marginTop: 'var(--sp-2)' }}>Connected accounts</h2>
      <p className="muted" style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-sm)' }}>Accounts of yours that your agent may read through — each a credential kept for you, revocable here.</p>
      <ConnectorCard name="calendar" />
      <ConnectorCard name="gmail" />
      <ConnectorCard name="drive" />
      <YouVersionData />
      <h2 className="ui-h2" style={{ marginTop: 'var(--sp-5)' }}>Connected apps</h2>
      <p className="muted" style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-sm)' }}>Apps and assistants you authorized to act as clients of you — what each may do is a grant, listed here and on Grants.</p>
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

      {/* Spec 397 W4 — assistants holding the person's OWN wire (Claude through the Home MCP), revocable on chain. */}
      <AppGrantsPanel />

      {/* spec 341 §4.3 — the other half of "connected": which apps may READ, per app and per record
          family. Connecting proves identity; this authorizes access, and the two are separate yeses. */}
      <div style={{ marginTop: '1.5rem' }}>
        <AppReadGrants />
      </div>

      {/* Moved here from the old /you Connected tab (spec 315): how other agents find + reach you. */}
      <div style={{ marginTop: '1.5rem' }}>
        <HomeManifestCard />
      </div>
      <div style={{ marginTop: '1rem' }}>
        <DirectoryListingCard />
      </div>
    </SectionShell>
  );
}
