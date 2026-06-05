'use client';
// Your home (dashboard) at `/` — a map of what you steward + how you keep it secure. The gate
// guarantees an authed session here. Renders from the stewardship domain model.
import { useSession } from '../../src/context/session';
import { whitelabel } from '../../src/whitelabel/config';
import { stewardedThings } from '../../src/home/stewardship';
import { AddressChip } from '../../src/components/shared/AddressChip';
import { LockIcon } from '../../src/components/shared/Icons';
import { ClaimPublicNameCard } from '../../src/components/portal/ClaimPublicNameCard';

export default function HomeDashboard() {
  const { agentName, agentAddress, session } = useSession();
  const things = stewardedThings();

  return (
    <div className="dashboard">
      {session?.fresh && (
        <div className="welcome-banner" role="status">
          <strong>{whitelabel.copy.portalWelcome}{agentName ? `, ${agentName}` : ''}</strong>
          <span>You&apos;re all set. This is your home in the {whitelabel.brand.community}.</span>
        </div>
      )}

      <section className="dash-section">
        <h2>You</h2>
        <div className="agent-identity-card hero">
          <div className="agent-identity-name">{agentName ?? 'Your home'}</div>
          {agentAddress && <AddressChip address={agentAddress} />}
          <div className="agent-identity-sub">{whitelabel.copy.portalYouLabel} · Secured ✓</div>
          <a className="btn-ghost" href="/you">View your home →</a>
        </div>
      </section>

      {/* spec 257 (greenfield 08) — the deferred, optional, dismissible "Claim your public name"
          card. With true name-deferral a fresh Google home arrives NAMELESS, so this surfaces the
          public handle LATER as a desirable choice, not an onboarding gate. Self-hides if dismissed. */}
      <ClaimPublicNameCard />

      <section className="dash-section">
        <h2>{whitelabel.copy.portalManageHeading}</h2>
        <div className="manage-grid">
          {things.map((t) => (
            <div key={t.kind} className={`manage-card ${t.status}`}>
              <div className="manage-card-head">
                <span className="manage-card-label">{t.label}</span>
                <span className={`manage-card-badge ${t.status}`}>
                  {t.status === 'live' ? '✓ Live' : <><LockIcon size={12} /> Coming soon</>}
                </span>
              </div>
              <p className="manage-card-blurb">{t.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <h2>Your home</h2>
        <div className="manage-grid">
          {whitelabel.services.connectedApps && (
            <a className="manage-card link" href="/apps">
              <div className="manage-card-label">Connected apps</div>
              <p className="manage-card-blurb">Apps you&apos;ve given permission — see what each can do, revoke anytime.</p>
            </a>
          )}
          {whitelabel.services.devices && (
            <a className="manage-card link" href="/security">
              <div className="manage-card-label">Security</div>
              <p className="manage-card-blurb">How you keep your home secure — your sign-in and linked devices.</p>
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
