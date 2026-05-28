'use client';
// One sign-in method / linked device. "Remove" is destructive (inline confirm) and only
// shown when removable (never leave zero credentials).
import { useState, type ReactNode } from 'react';
import { InlineConfirm } from '../shared/InlineConfirm';

export function DeviceRow({
  icon,
  name,
  sub,
  isThisDevice = false,
  removable = false,
  removeLabel = 'Remove',
  onRemove,
}: {
  icon: ReactNode;
  name: string;
  sub?: string;
  isThisDevice?: boolean;
  removable?: boolean;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="device-row">
      <div className="device-row-main">
        <span className="device-row-icon" aria-hidden="true">{icon}</span>
        <div>
          <div className="device-row-name">
            {name}
            {isThisDevice && <span className="device-row-badge">This device</span>}
          </div>
          {sub && <div className="device-row-sub">{sub}</div>}
        </div>
        {removable && !confirming && (
          <button type="button" className="btn-ghost device-row-remove" onClick={() => setConfirming(true)}>{removeLabel}</button>
        )}
      </div>
      {confirming && (
        <InlineConfirm
          title={`${removeLabel} this sign-in method?`}
          body="You'll no longer be able to sign in with it. Your agent address never changes."
          confirmLabel={`Yes, ${removeLabel.toLowerCase()}`}
          dangerous
          onConfirm={() => { onRemove?.(); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
