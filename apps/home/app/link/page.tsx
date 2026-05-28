'use client';
// /link — standalone cross-device passkey linking (spec 233 P2). The direct-link fallback;
// outside the portal gate (a credential-less device must reach it without signing in first).
import { useState } from 'react';
import { NewDevice, ApproveDevice } from '../../src/components/device-link';
import { BrandShield } from '../../src/components/shared/BrandShield';
import { whitelabel } from '../../src/whitelabel/config';

export default function LinkPage() {
  const [mode, setMode] = useState<'new' | 'approve'>('new');
  return (
    <div className="onboarding-screen">
      <div className="onboarding-card" style={{ alignItems: 'stretch', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <BrandShield size={28} />
          <strong style={{ fontWeight: 800, color: 'var(--color-text-primary)' }}>{whitelabel.brand.name}</strong>
        </div>
        <h1 className="onboarding-h1">Link a device</h1>
        <p className="onboarding-sub">
          Passkeys are bound to one device. Set up a passkey on a new device, then approve it from a device that already has yours.
        </p>
        <div className="link-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'new'} className={`link-tab${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>
            Set up this device
          </button>
          <button role="tab" aria-selected={mode === 'approve'} className={`link-tab${mode === 'approve' ? ' active' : ''}`} onClick={() => setMode('approve')}>
            Approve a device
          </button>
        </div>
        {mode === 'new' ? <NewDevice /> : <ApproveDevice />}
      </div>
    </div>
  );
}
