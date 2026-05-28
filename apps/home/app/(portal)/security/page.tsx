'use client';
// Security & Recovery — sign-in methods, linked devices, recovery. Reuses the existing
// add-credential + cross-device-link primitives. Recovery (trustees/guardians) is coming soon.
import { useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import { addWalletCredential, addPasskeyCredential, stepUpToAgent } from '../../../src/connect-client';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { DeviceRow } from '../../../src/components/portal/DeviceRow';
import { ApproveDevice } from '../../../src/components/device-link';
import { FingerprintIcon, MonitorIcon, ShieldIcon } from '../../../src/components/shared/Icons';

export default function SecurityPage() {
  const { session, agentAddress, openSession } = useSession();
  const via = session?.via ?? '';
  const [add, setAdd] = useState<{ step?: string; done?: string; error?: string } | null>(null);
  const [showApprove, setShowApprove] = useState(false);
  const [stepUpMsg, setStepUpMsg] = useState<string | null>(null);

  // Google = login-grade. Managing security needs a custody credential → step up first.
  if (via === 'Google') {
    const stepUp = async (m: 'passkey' | 'wallet') => {
      if (!session) return;
      setStepUpMsg('Confirming…');
      try {
        const out = await stepUpToAgent(m, session.token);
        if (out.ok) await openSession(out.token, m, false);
        else setStepUpMsg(out.error);
      } catch (e) {
        setStepUpMsg(e instanceof Error ? e.message : 'step-up failed');
      }
    };
    return (
      <SectionShell title="Security & Recovery" description="Confirm with a custody credential to manage your sign-in methods.">
        <div className="agent-identity-card">
          <p className="onboarding-sub">You&apos;re signed in with Google (sign-in only). Confirm with your passkey or wallet to manage security.</p>
          <button className="btn-primary" onClick={() => stepUp('passkey')}>Continue with passkey</button>
          <button className="btn-ghost" onClick={() => stepUp('wallet')}>Continue with wallet</button>
          {stepUpMsg && <p className="onboarding-hint taken">{stepUpMsg}</p>}
        </div>
      </SectionShell>
    );
  }

  const personAgent = agentAddress as Address | null;
  const addComplementary = async () => {
    if (!personAgent) return;
    setAdd({ step: 'Starting…' });
    try {
      const onStep = (s: string) => setAdd({ step: s });
      if (via === 'passkey') {
        const r = await addWalletCredential(personAgent, onStep);
        setAdd(r.ok ? { done: `Wallet ${r.added.slice(0, 6)}…${r.added.slice(-4)} added` } : { error: r.error });
      } else {
        const r = await addPasskeyCredential(personAgent, onStep);
        setAdd(r.ok ? { done: 'Passkey added' } : { error: r.error });
      }
    } catch (e) {
      setAdd({ error: e instanceof Error ? e.message : 'add failed' });
    }
  };

  return (
    <SectionShell
      title="Security & Recovery"
      description="Your portal is protected by your device's biometrics. Manage your sign-in methods and linked devices here."
    >
      <div className="dash-section">
        <h2>Sign-in methods</h2>
        <DeviceRow
          icon={<FingerprintIcon size={20} />}
          name={via === 'passkey' ? 'Passkey' : 'Wallet'}
          sub={via === 'passkey' ? 'This device' : 'Connected wallet'}
          isThisDevice={via === 'passkey'}
        />
        {add?.done ? (
          <p className="onboarding-hint ok" style={{ marginTop: '.5rem' }}>✓ {add.done} — same agent, same details.</p>
        ) : add?.step ? (
          <p className="muted" style={{ marginTop: '.5rem', display: 'flex', gap: '.4rem', alignItems: 'center' }}><span className="spinner" /> {add.step}</p>
        ) : (
          <button className="btn-ghost" style={{ marginTop: '.65rem' }} onClick={addComplementary}>
            {via === 'passkey' ? 'Add a wallet' : 'Add a passkey'}
          </button>
        )}
        {add?.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{add.error}</p>}
      </div>

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Linked devices</h2>
        <DeviceRow icon={<MonitorIcon size={20} />} name="This device" sub="Signed in here" isThisDevice />
        {showApprove ? (
          <div style={{ marginTop: '.65rem' }}><ApproveDevice /></div>
        ) : (
          <button className="btn-ghost" style={{ marginTop: '.65rem' }} onClick={() => setShowApprove(true)}>
            Add another device
          </button>
        )}
      </div>

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Recovery</h2>
        <ComingSoonState
          icon={<ShieldIcon size={40} />}
          title="Recovery options"
          body="Trustees and guardians who can help recover your portal if you lose access — without ever changing your identity."
        />
      </div>
    </SectionShell>
  );
}
