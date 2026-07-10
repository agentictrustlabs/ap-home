'use client';
// Your home (dashboard) at `/` — a map of what you steward + how you keep it secure. The gate
// guarantees an authed session here. Renders from the stewardship domain model.
import { useSession } from '../../src/context/session';
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
  organization: '/organizations',
  treasury: '/treasuries',
  'data-source': '/data-sources',
};
const STEWARD_ICON: Record<string, typeof BuildingIcon> = {
  organization: BuildingIcon,
  treasury: LandmarkIcon,
  'data-source': DatabaseIcon,
};

export default function HomeDashboard() {
  const { agentName, agentAddress, session } = useSession();
  const things = stewardedThings();
  const avatarUrl = useAvatar(agentAddress ? personAvatarKey(agentAddress) : null);

  return (
    <div className="dashboard">
      <header className="section-head">
        <h1>Home</h1>
        <p className="section-desc">Everything you steward in the {whitelabel.brand.community} — at a glance.</p>
      </header>
      {session?.fresh && (
        <div className="welcome-banner" role="status">
          <strong>{whitelabel.copy.portalWelcome}{agentName ? `, ${agentName}` : ''}</strong>
          <span>You&apos;re all set. This is your home in the {whitelabel.brand.community}.</span>
        </div>
      )}

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
          <a className="btn-ghost" href="/you">View your home →</a>
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
