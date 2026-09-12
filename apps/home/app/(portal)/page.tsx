'use client';
// TODAY at `/` — spec 398 §4.2: the outcome-led first page (what needs my decision · what is active · what
// finished · what next), in a fixed order, then who you are and what you steward (the map this page used to be).
// The gate guarantees an authed session here.
import { useSession } from '../../src/context/session';
import { TodayView } from '../../src/components/portal/TodayView';
import { ExplorerLink } from '../../src/components/shared/ExplorerLink';
import { whitelabel } from '../../src/whitelabel/config';
import { stewardedThings } from '../../src/home/stewardship';
import { AddressChip } from '../../src/components/shared/AddressChip';
import { LockIcon, BuildingIcon, LandmarkIcon, DatabaseIcon, ExternalLinkIcon, ShieldIcon, CheckIcon } from '../../src/components/shared/Icons';
import { Avatar } from '../../src/components/portal/chat/Avatar';
import { personAvatarKey } from '../../src/lib/avatar-store';
import { useAvatar } from '../../src/components/portal/chat/use-avatar';
import { PageHead, Section, Card, KeyValue } from '../../src/ui';

// Which dedicated page each stewarded area links to (live areas only; spec 275), plus the icon
// that gives the manage-card its identity at a glance (Discord/Telegram-style iconography).
const STEWARD_HREF: Record<string, string | undefined> = {
  organization: '/agents',
  treasury: '/treasuries',
  'data-source': '/data-sources',
};
const STEWARD_ICON: Record<string, typeof BuildingIcon> = {
  organization: BuildingIcon,
  treasury: LandmarkIcon,
  'data-source': DatabaseIcon,
};

export default function HomeDashboard() {
  const { agentName, agentAddress, session, profile } = useSession();
  const things = stewardedThings();
  const avatarUrl = useAvatar(agentAddress ? personAvatarKey(agentAddress) : null);

  return (
    <div className="dashboard">
      <PageHead title="Today" description={<>What needs you, what is in motion, what finished — and who you are in the {whitelabel.brand.community}.</>} />
      {session?.fresh && (
        <div className="welcome-banner" role="status">
          <strong>{whitelabel.copy.portalWelcome}{agentName ? `, ${agentName}` : ''}</strong>
          <span>You&apos;re all set. This is your home in the {whitelabel.brand.community}.</span>
        </div>
      )}

      <TodayView scope={{ kind: 'person' }} />

      <Section title="You" aside={<a href="/profile">Edit your profile →</a>}>
        <Card>
          <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'center', flexWrap: 'wrap' }}>
            <Avatar name={agentName ?? 'You'} imageUrl={avatarUrl} size={48} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ui-card-title">{agentName ?? 'Your home'}</div>
              <div className="ui-meta" style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>{whitelabel.copy.portalYouLabel} · secured <CheckIcon size={13} style={{ color: 'var(--color-sage-600, #16a34a)' }} /></div>
            </div>
            {agentAddress && <AddressChip address={agentAddress} />}
          </div>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <KeyValue rows={[
              ['access', profile?.access === 'standard' ? 'Standard' : 'Full access'],
              ...(agentAddress ? [['on chain', <ExplorerLink address={agentAddress} label="explorer ↗" />] as [React.ReactNode, React.ReactNode]] : []),
            ]} />
          </div>
        </Card>
      </Section>

      {/* spec 257 — the "Claim your public name" card lives on the Naming Service tab (/naming),
          not the home page (its ClaimNameCard surfaces the nameless→named choice there). */}
      <Section title={whitelabel.copy.portalManageHeading}>
        <div className="manage-grid">
          {things.map((t) => {
            const href = STEWARD_HREF[t.kind];
            const Icon = STEWARD_ICON[t.kind] ?? BuildingIcon;
            const body = (
              <>
                <div className="ui-card-head" style={{ marginBottom: 4 }}>
                  <span className="ui-card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-md)' }}><Icon size={16} /> {t.label}</span>
                  {t.status !== 'live' && <span className="ui-chip"><LockIcon size={11} /> soon</span>}
                </div>
                <p className="ui-meta" style={{ margin: 0 }}>{t.blurb}</p>
              </>
            );
            // Live areas link to their dedicated page; "soon" areas stay non-clickable.
            return t.status === 'live' && href ? (
              <a key={t.kind} className="ui-card" href={href} style={{ margin: 0 }}>{body}</a>
            ) : (
              <div key={t.kind} className="ui-card ui-card--quiet" style={{ margin: 0 }}>{body}</div>
            );
          })}
        </div>
      </Section>

      <Section title="Your home">
        <div className="manage-grid">
          {whitelabel.services.connectedApps && (
            <a className="ui-card" href="/apps" style={{ margin: 0 }}>
              <div className="ui-card-head" style={{ marginBottom: 4 }}><span className="ui-card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-md)' }}><ExternalLinkIcon size={16} /> Connected apps</span></div>
              <p className="ui-meta" style={{ margin: 0 }}>Apps you&apos;ve given permission — see what each can do, revoke anytime.</p>
            </a>
          )}
          {whitelabel.services.devices && (
            <a className="ui-card" href="/security" style={{ margin: 0 }}>
              <div className="ui-card-head" style={{ marginBottom: 4 }}><span className="ui-card-title" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-md)' }}><ShieldIcon size={16} /> Security</span></div>
              <p className="ui-meta" style={{ margin: 0 }}>How you keep your home secure — your sign-in and linked devices.</p>
            </a>
          )}
        </div>
      </Section>
    </div>
  );
}
