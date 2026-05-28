'use client';
// App-grant consent — the deliberate, honest "what can this app do" disclosure. The
// can/cannot lists + logo come from REGISTERED white-label config (anti-spoof), passed as
// props by the page. Hard rule: cannotDo must be non-empty (honest disclosure).
import { CheckIcon, XIcon } from './Icons';

export interface ConsentTemplate {
  canDo: string[];
  cannotDo: string[];
  expiryDays?: number;
}

export function ConsentSheet({
  title,
  appName,
  appDomain,
  appLogo,
  template,
  busy = false,
  authorizeLabel,
  declineLabel = 'Not now',
  onAuthorize,
  onDecline,
}: {
  title: string;
  appName: string;
  appDomain: string;
  appLogo?: string;
  template: ConsentTemplate;
  busy?: boolean;
  authorizeLabel: string;
  declineLabel?: string;
  onAuthorize: () => void;
  onDecline: () => void;
}) {
  if (process.env.NODE_ENV !== 'production' && template.cannotDo.length === 0) {
    throw new Error('ConsentSheet: template.cannotDo must be non-empty (honest disclosure is required).');
  }
  return (
    <div className="consent-sheet">
      <div className="consent-app">
        {appLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={appLogo} alt="" className="consent-app-logo" />
        ) : (
          <div className="consent-app-logo placeholder" aria-hidden="true">{appName.slice(0, 1).toUpperCase()}</div>
        )}
        <div>
          <div className="consent-app-name">{appName}</div>
          <div className="consent-app-domain">{appDomain}</div>
        </div>
      </div>

      <h2 className="consent-title">{title}</h2>

      <ul className="consent-list can" aria-label="What this app can do">
        {template.canDo.map((c) => (
          <li key={c}><span className="consent-icon ok" aria-hidden="true"><CheckIcon size={14} /></span>Can: {c}</li>
        ))}
      </ul>
      <ul className="consent-list cannot" aria-label="What this app cannot do">
        {template.cannotDo.map((c) => (
          <li key={c}><span className="consent-icon no" aria-hidden="true"><XIcon size={14} /></span>Cannot: {c}</li>
        ))}
      </ul>

      <div className="consent-expiry">
        {template.expiryDays
          ? `Permission expires in ${template.expiryDays} days`
          : 'Permission is ongoing until you revoke it'}
      </div>
      <p className="consent-note">You can revoke this anytime from Connected Apps in your portal.</p>

      <div className="consent-actions">
        <button type="button" className="btn-primary" onClick={onAuthorize} disabled={busy}>
          {busy ? 'Connecting…' : authorizeLabel}
        </button>
        <button type="button" className="btn-ghost" onClick={onDecline} disabled={busy}>
          {declineLabel}
        </button>
      </div>
    </div>
  );
}
