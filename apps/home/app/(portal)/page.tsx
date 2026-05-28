'use client';
// Portal Home (dashboard) at `/` — a map of the member's portal. The gate guarantees an
// authed session here. (Step 6 enriches the identity + manage grid; Step 3 = the frame.)
import { useSession } from '../../src/context/session';
import { whitelabel } from '../../src/whitelabel/config';
import { AddressChip } from '../../src/components/shared/AddressChip';
import { LockIcon } from '../../src/components/shared/Icons';

export default function PortalHome() {
  const { profile, agentName, agentAddress, session } = useSession();
  const others = whitelabel.manageableAgents.filter((a) => a.id !== 'person');

  return (
    <div className="dashboard">
      {session?.fresh && (
        <div className="welcome-banner" role="status">
          <strong>{whitelabel.copy.portalWelcome}{agentName ? `, ${agentName}` : ''}</strong>
          <span>You&apos;re all set. This is your home.</span>
        </div>
      )}

      <section className="dash-section">
        <h2>You</h2>
        <div className="agent-identity-card hero">
          <div className="agent-identity-name">{agentName ?? 'Your portal'}</div>
          {agentAddress && <AddressChip address={agentAddress} />}
          <div className="agent-identity-sub">{whitelabel.copy.portalYouLabel} · Base Sepolia</div>
          <a className="btn-ghost" href="/you">View your agent →</a>
        </div>
      </section>

      <section className="dash-section">
        <h2>{whitelabel.copy.portalManageHeading}</h2>
        <div className="manage-grid">
          {others.map((a) => (
            <div key={a.id} className={`manage-card ${a.status}`}>
              <div className="manage-card-head">
                <span className="manage-card-label">{a.label}</span>
                <span className={`manage-card-badge ${a.status}`}>
                  {a.status === 'live' ? '✓ Live' : <><LockIcon size={12} /> Coming soon</>}
                </span>
              </div>
              <p className="manage-card-blurb">{a.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <h2>Portal management</h2>
        <div className="manage-grid">
          {whitelabel.services.connectedApps && (
            <a className="manage-card link" href="/apps">
              <div className="manage-card-label">Connected apps</div>
              <p className="manage-card-blurb">Apps you&apos;ve authorized — see what each can do, revoke anytime.</p>
            </a>
          )}
          {whitelabel.services.devices && (
            <a className="manage-card link" href="/security">
              <div className="manage-card-label">Security</div>
              <p className="manage-card-blurb">Your sign-in methods and the devices linked to your portal.</p>
            </a>
          )}
        </div>
      </section>
      {/* profile unused in Step 3 frame; surfaced in /you (Step 6) */}
      <span hidden>{profile?.access}</span>
    </div>
  );
}
