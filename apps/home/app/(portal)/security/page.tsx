'use client';
// Security & Recovery — sign-in methods, linked devices, recovery. Reuses the existing
// add-credential + cross-device-link primitives. Recovery (trustees/guardians) is coming soon.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { whitelabel } from '../../../src/whitelabel/config';
import {
  addWalletCredential,
  addPasskeyCredential,
  removeWalletCredential,
  removePasskeyCredential,
  readCredentialCounts,
  currentCredentialSignHash,
  stepUpToAgent,
} from '../../../src/connect-client';
import { loadPasskey } from '../../../src/lib/passkey';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { ComingSoonState } from '../../../src/components/portal/ComingSoonState';
import { DeviceRow } from '../../../src/components/portal/DeviceRow';
import { ApproveDevice } from '../../../src/components/device-link';
import { FingerprintIcon, MonitorIcon, ShieldIcon } from '../../../src/components/shared/Icons';

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
  const [counts, setCounts] = useState<{ custodians: number; passkeys: number } | null>(null);
  const [remove, setRemove] = useState<{ open?: boolean; addr?: string; step?: string; done?: string; error?: string }>({});

  // Live credential set (view call). Re-read after an add/remove completes.
  useEffect(() => {
    if (!personAgent || via === 'Google') return;
    let live = true;
    readCredentialCounts(personAgent).then((c) => live && setCounts(c)).catch(() => {});
    return () => { live = false; };
  }, [personAgent, via, add?.done, remove.done]);

  const total = counts ? counts.custodians + counts.passkeys : null;
  const canRemove = total != null && total > 1; // the contract refuses the last one too

  const addComplementary = async () => {
    if (!personAgent) return;
    setAdd({ step: 'Starting…' });
    try {
      const onStep = (s: string) => setAdd({ step: s });
      if (via === 'passkey') {
        const r = await addWalletCredential(personAgent, onStep);
        setAdd(r.ok ? { done: `Wallet ${shortAddr(r.added)} added` } : { error: r.error });
      } else {
        const r = await addPasskeyCredential(personAgent, onStep);
        setAdd(r.ok ? { done: 'Passkey added' } : { error: r.error });
      }
    } catch (e) {
      setAdd({ error: e instanceof Error ? e.message : 'add failed' });
    }
  };

  // Removal uses the CURRENT credential to sign `execute(self, removeX)`. The contract blocks
  // removing your last method, so you can't lock yourself out (CannotRemoveLastCustodian).
  const removeWallet = async () => {
    const addr = (remove.addr ?? '').trim();
    if (!personAgent || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setRemove((r) => ({ ...r, error: 'Enter a valid 0x wallet address.' }));
      return;
    }
    setRemove((r) => ({ ...r, step: 'Confirm with your current sign-in…', error: undefined }));
    try {
      const signHash = await currentCredentialSignHash(via as 'passkey' | 'wallet');
      const res = await removeWalletCredential(personAgent, addr as Address, signHash);
      setRemove(res.ok ? { done: `Wallet ${shortAddr(addr)} removed` } : { open: true, addr, error: res.error });
    } catch (e) {
      setRemove({ open: true, addr, error: e instanceof Error ? e.message : 'remove failed' });
    }
  };
  const removeThisDevice = async () => {
    const pk = loadPasskey();
    if (!personAgent || !pk) return;
    setRemove((r) => ({ ...r, step: 'Removing this device…', error: undefined }));
    try {
      const signHash = await currentCredentialSignHash(via as 'passkey' | 'wallet');
      const res = await removePasskeyCredential(personAgent, pk.credentialIdDigest, signHash);
      setRemove(res.ok ? { done: 'This device’s passkey was removed' } : { open: true, error: res.error });
    } catch (e) {
      setRemove({ open: true, error: e instanceof Error ? e.message : 'remove failed' });
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
        {total != null && (
          <p className="muted" style={{ marginTop: '.4rem', fontSize: '.85rem' }}>
            {total} {total === 1 ? 'method' : 'methods'} open this home
            {counts ? ` — ${counts.passkeys} passkey${counts.passkeys === 1 ? '' : 's'}, ${counts.custodians} wallet${counts.custodians === 1 ? '' : 's'}` : ''}.
            {total === 1 && ' Add another so you’re never locked out.'}
          </p>
        )}
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

        {/* Remove (replace a lost device) — symmetric onlySelf op, signed by the current credential. */}
        {remove.done ? (
          <p className="onboarding-hint ok" style={{ marginTop: '.75rem' }}>✓ {remove.done} — your home and name are unchanged.</p>
        ) : remove.step ? (
          <p className="muted" style={{ marginTop: '.75rem', display: 'flex', gap: '.4rem', alignItems: 'center' }}><span className="spinner" /> {remove.step}</p>
        ) : !remove.open ? (
          <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem' }} onClick={() => setRemove({ open: true })}>
            Remove a sign-in method
          </button>
        ) : (
          <div className="remove-credential" style={{ marginTop: '.65rem' }}>
            {!canRemove ? (
              <p className="muted" style={{ fontSize: '.85rem' }}>
                This is your only sign-in method — add another above before removing one (you can’t lock yourself out).
              </p>
            ) : (
              <>
                <p className="muted" style={{ fontSize: '.85rem', marginBottom: '.4rem' }}>
                  Removing a method revokes its access immediately. Your home, name, and connected apps are untouched.
                </p>
                <input
                  className="onboarding-input"
                  value={remove.addr ?? ''}
                  onChange={(e) => setRemove((r) => ({ ...r, addr: e.target.value, error: undefined }))}
                  placeholder="Wallet address to remove (0x…)"
                  aria-label="Wallet address to remove"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <button className="btn-ghost" style={{ marginTop: '.4rem' }} onClick={removeWallet}>Remove this wallet</button>
                {via === 'passkey' && loadPasskey() && (
                  <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem' }} onClick={removeThisDevice}>
                    Remove this device’s passkey (signs you out here)
                  </button>
                )}
              </>
            )}
            <button className="btn-ghost onboarding-secondary" style={{ marginTop: '.4rem' }} onClick={() => setRemove({})}>Cancel</button>
          </div>
        )}
        {remove.error && <p className="onboarding-hint taken" style={{ marginTop: '.5rem' }}>{remove.error}</p>}
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
