'use client';
// One relying app's grant: what it can/cannot do, dates, and a revoke control. The
// active→revoking→revoked shape is built, but revoke transitions are gated behind
// `revokeEnabled` (false today — revoke is custody-grade, see Step-7/security follow-up).
import { useState } from 'react';
import type { Permission } from '../../home/types';
import { CheckIcon, XIcon } from '../shared/Icons';
import { InlineConfirm } from '../shared/InlineConfirm';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function ConnectedAppCard({
  app,
  revokeEnabled = false,
  onRevoke,
}: {
  app: Permission;
  revokeEnabled?: boolean;
  onRevoke?: (clientId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const expired = !!app.expiresAt && Date.now() > app.expiresAt;

  return (
    <div className={`connected-app-card${expired ? ' expired' : ''}`}>
      <div className="connected-app-head">
        {app.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={app.logo} alt="" className="connected-app-logo" />
        ) : (
          <div className="connected-app-logo placeholder" aria-hidden="true">{app.appName.slice(0, 1).toUpperCase()}</div>
        )}
        <div>
          <div className="connected-app-name">{app.appName}</div>
          <div className="connected-app-domain">{app.appDomain}</div>
        </div>
      </div>

      <ul className="consent-list can">
        {app.canDo.map((c) => <li key={c}><span className="consent-icon ok"><CheckIcon size={14} /></span>{c}</li>)}
      </ul>
      <ul className="consent-list cannot">
        {app.cannotDo.map((c) => <li key={c}><span className="consent-icon no"><XIcon size={14} /></span>{c}</li>)}
      </ul>

      <div className="connected-app-meta">
        <span>Granted {fmtDate(app.grantedAt)}</span>
        {app.expiresAt && (
          <span className={expired ? 'expired' : ''}>
            {expired ? `Expired ${fmtDate(app.expiresAt)}` : `Expires ${fmtDate(app.expiresAt)}`}
          </span>
        )}
      </div>

      {confirming ? (
        <InlineConfirm
          title={`Revoke ${app.appName}'s access?`}
          body={`${app.appName} won't be able to act on your behalf until you authorize it again.`}
          confirmLabel="Yes, revoke access"
          dangerous
          onConfirm={() => { onRevoke?.(app.clientId); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      ) : revokeEnabled ? (
        <button type="button" className="btn-danger-outline" onClick={() => setConfirming(true)}>Revoke access</button>
      ) : (
        <button type="button" className="btn-ghost" disabled title="Revocation is custody-grade — coming soon">
          Revoke access — coming soon
        </button>
      )}
    </div>
  );
}
