'use client';
// Email sign-in / add-email card (email-auth Phase 1b). Two-step: enter email → get a 6-digit code →
// verify. Behavior depends on whether there's a session: signed-in ⇒ LINK (add email as a login method),
// anonymous ⇒ ISSUE a login-grade session (or BOOTSTRAP if there's no home for that email yet).
import { useState } from 'react';
import { useSession } from '../../context/session';
import { secureHomeNoName, activateVault } from '../../home/onboarding';

export function EmailAuthCard({ onLinked }: { onLinked?: () => void }) {
  const { session, openSession } = useSession();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const start = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await fetch('/connect/email/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string; devCode?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'could not send the code');
      setStep('code');
      setNote(d.delivery === 'logged'
        ? (d.devCode ? `Email isn’t configured (dev) — your code is ${d.devCode}.` : 'Email sending isn’t configured yet — the code was logged server-side (dev).')
        : `We sent a 6-digit code to ${email.trim()}.`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const verify = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/connect/email/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {}) },
        body: JSON.stringify({ email: email.trim().toLowerCase(), otp: otp.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { status?: string; token?: string; custody?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'verification failed');
      if (d.status === 'linked') {
        setStep('email'); setEmail(''); setOtp(''); setNote('Email added as a sign-in method.');
        onLinked?.();
      } else if (d.status === 'issued' && d.token) {
        if (d.custody) {
          // Email-bootstrap: this email owns a KMS-custodied home. Secure it on-chain FIRST (demo-a2a
          // derives + holds the per-subject key — no device gesture), then open the session so the portal
          // loads a deployed, resolvable home.
          setNote('Securing your home…');
          const res = await secureHomeNoName({ token: d.token }, { claimPendingNameVia: 'email' });
          if (!res.ok) throw new Error(res.error);
          void activateVault(res.home.address, 'email', { token: d.token }); // spec 278 — best-effort vault
        }
        await openSession(d.token, 'email', false);
      } else if (d.status === 'bootstrap') {
        setErr('We couldn’t set up a home for this email automatically — sign up with a passkey or Google, then add email.');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 380 }}>
      {step === 'email' ? (
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder="you@example.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && email.trim()) void start(); }}
            style={{ flex: 1, minWidth: 200, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8 }}
          />
          <button className="btn" disabled={busy || !email.trim()} onClick={() => void start()}>
            {busy ? '…' : session ? 'Add email' : 'Continue'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input
            inputMode="numeric"
            placeholder="6-digit code"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter' && otp.length === 6) void verify(); }}
            autoFocus
            style={{ width: 130, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8, letterSpacing: '2px' }}
          />
          <button className="btn" disabled={busy || otp.length !== 6} onClick={() => void verify()}>
            {busy ? '…' : 'Verify'}
          </button>
          <button className="btn-ghost" onClick={() => { setStep('email'); setOtp(''); setErr(null); }}>Back</button>
        </div>
      )}
      {note && <p style={{ fontSize: '.78rem', color: 'var(--color-text-muted)', margin: '.5rem 0 0' }}>{note}</p>}
      {err && <p style={{ fontSize: '.78rem', color: 'var(--color-danger)', margin: '.5rem 0 0' }}>{err}</p>}
    </div>
  );
}
