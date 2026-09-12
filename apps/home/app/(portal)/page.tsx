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
      <header className="section-head">
        <h1>Today</h1>
        <p className="section-desc">What needs you, what is in motion, what finished — and who you are in the {whitelabel.brand.community}.</p>
      </header>
      {session?.fresh && (
        <div className="welcome-banner" role="status">
          <strong>{whitelabel.copy.portalWelcome}{agentName ? `, ${agentName}` : ''}</strong>
          <span>You&apos;re all set. This is your home in the {whitelabel.brand.community}.</span>
        </div>
      )}

      <TodayView scope={{ kind: 'person' }} />

      <section className="dash-section">
        <h2>You</h2>
        <div className="agent-identity-card hero">
          <div className="agent-identity-card-top">
            <Avatar name={agentName ?? 'You'} imageUrl={avatarUrl} size={52} />
            <div>
              <div className="agent-identity-name">{agentName ?? 'Your home'}</div>
              <div className="agent-identity-sub" style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                {whitelabel.copy.portalYouLabel} · Secured <CheckIcon size={13} style={{ color: 'var(--color-sage-600, #16a34a)' }} />
              </div>
            </div>
          </div>
          {agentAddress && <AddressChip address={agentAddress} />}
          {/* The access level and the explorer link used to live on a separate /you page. That page said
              nothing this card does not, so it is gone — but these two facts came with it, and dropping
              them silently would have been a quiet loss rather than a simplification. */}
          <p className="manage-card-blurb" style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', margin: '.2rem 0 0' }}>
            <span>Access: <b>{profile?.access === 'standard' ? 'Standard' : 'Full access'}</b></span>
            {agentAddress && <ExplorerLink address={agentAddress} label="explorer ↗" />}
          </p>
          {/* This IS your home, so "view your home" led nowhere. The useful link is where the details
              behind this card are edited. */}
          <a className="btn-ghost" href="/profile">Edit your profile →</a>
        </div>
      </section>

      {/* spec 257 — the "Claim your public name" card lives on the Naming Service tab (/naming),
          not the home page (its ClaimNameCard surfaces the nameless→named choice there). */}
      <section className="dash-section">
        <h2>{whitelabel.copy.portalManageHeading}</h2>
        <div className="manage-grid">
          {things.map((t) => {
            const href = STEWARD_HREF[t.kind];
            const Icon = STEWARD_ICON[t.kind] ?? BuildingIcon;
            const body = (
              <>
                <div className="manage-card-head">
                  <span className="manage-card-icon"><Icon size={17} /></span>
                  <span className="manage-card-label">{t.label}</span>
                  <span className={`manage-card-badge ${t.status}`}>
                    {t.status === 'live' ? <><CheckIcon size={11} /> Live</> : <><LockIcon size={11} /> Coming soon</>}
                  </span>
                </div>
                <p className="manage-card-blurb">{t.blurb}</p>
              </>
            );
            // Live areas link to their dedicated page; "soon" areas stay non-clickable.
            return t.status === 'live' && href ? (
              <a key={t.kind} className="manage-card link live" href={href}>{body}</a>
            ) : (
              <div key={t.kind} className={`manage-card ${t.status}`}>{body}</div>
            );
          })}
        </div>
      </section>

      <section className="dash-section">
        <h2>Your home</h2>
        <div className="manage-grid">
          {whitelabel.services.connectedApps && (
            <a className="manage-card link" href="/apps">
              <div className="manage-card-head">
                <span className="manage-card-icon"><ExternalLinkIcon size={17} /></span>
                <span className="manage-card-label">Connected apps</span>
              </div>
              <p className="manage-card-blurb">Apps you&apos;ve given permission — see what each can do, revoke anytime.</p>
            </a>
          )}
          {whitelabel.services.devices && (
            <a className="manage-card link" href="/security">
              <div className="manage-card-head">
                <span className="manage-card-icon"><ShieldIcon size={17} /></span>
                <span className="manage-card-label">Security</span>
              </div>
              <p className="manage-card-blurb">How you keep your home secure — your sign-in and linked devices.</p>
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
