'use client';
// Phone (SMS) sign-in / add-phone card (phone-auth, spec 320). Two-step: enter phone → get an SMS code →
// verify. Behavior mirrors EmailAuthCard: signed-in ⇒ LINK (add phone as a login/recovery method),
// anonymous ⇒ ISSUE a session (or BOOTSTRAP a KMS-custodied home if there's no home for that phone yet).
// SMS proves telecom-address control (contact-control), not custody — after a bootstrap the durable
// credential is a passkey (add one from Security & Recovery).
import { useState } from 'react';
import { useSession } from '../../context/session';
import { secureHomeNoName, activateVault } from '../../home/onboarding';

export function PhoneAuthCard({ onLinked }: { onLinked?: () => void }) {
  const { session, openSession } = useSession();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const start = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await fetch('/connect/phone/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'could not send the code');
      setStep('code');
      setNote(d.delivery === 'logged'
        ? 'SMS isn’t configured yet — the code was logged server-side (dev).'
        : `We sent a 6-digit code to ${phone.trim()}.`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/connect/phone/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {}) },
        body: JSON.stringify({ phone: phone.trim(), otp: otp.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { status?: string; token?: string; custody?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'verification failed');
      if (d.status === 'linked') {
        setStep('phone'); setPhone(''); setOtp(''); setNote('Phone added as a sign-in / recovery method.');
        onLinked?.();
      } else if (d.status === 'issued' && d.token) {
        if (d.custody) {
          // Phone-bootstrap: this phone owns a KMS-custodied home. Secure it on-chain (no gesture), then
          // open the session. Add a passkey from Security & Recovery for the durable credential.
          setNote('Securing your home…');
          const res = await secureHomeNoName({ token: d.token });
          if (!res.ok) throw new Error(res.error);
          void activateVault(res.home.address, 'phone', { token: d.token }); // spec 278 — best-effort vault
        }
        await openSession(d.token, 'phone', false);
      } else if (d.status === 'bootstrap') {
        setErr('We couldn’t set up a home for this number automatically — sign up with a passkey or Google, then add phone.');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 380 }}>
      {step === 'phone' ? (
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input
            type="tel"
            placeholder="+1 303 555 1234"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && phone.trim()) void start(); }}
            style={{ flex: 1, minWidth: 200, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8 }}
          />
          <button className="btn" disabled={busy || !phone.trim()} onClick={() => void start()}>
            {busy ? '…' : session ? 'Add phone' : 'Continue'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input
            inputMode="numeric"
            placeholder="6-digit code"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 10))}
            onKeyDown={(e) => { if (e.key === 'Enter' && otp.length >= 4) void verify(); }}
            autoFocus
            style={{ width: 130, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8, letterSpacing: '2px' }}
          />
          <button className="btn" disabled={busy || otp.length < 4} onClick={() => void verify()}>
            {busy ? '…' : 'Verify'}
          </button>
          <button className="btn-ghost" onClick={() => { setStep('phone'); setOtp(''); setErr(null); }}>Back</button>
        </div>
      )}
      {note && <p style={{ fontSize: '.78rem', color: 'var(--color-text-muted)', margin: '.5rem 0 0' }}>{note}</p>}
      {err && <p style={{ fontSize: '.78rem', color: 'var(--color-danger)', margin: '.5rem 0 0' }}>{err}</p>}
    </div>
  );
}
