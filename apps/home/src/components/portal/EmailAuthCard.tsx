'use client';
// Email sign-in / add-email card (email-auth Phase 1b). Two-step: enter email → get a 6-digit code →
// verify. Behavior depends on whether there's a session: signed-in ⇒ LINK (add email as a login method),
// anonymous ⇒ ISSUE a login-grade session (or BOOTSTRAP if there's no home for that email yet).
import { useState } from 'react';
import { useSession } from '../../context/session';

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
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'could not send the code');
      setStep('code');
      setNote(d.delivery === 'logged'
        ? 'Email sending isn’t configured yet — the code was logged server-side (dev).'
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
      const d = (await r.json().catch(() => ({}))) as { status?: string; token?: string; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'verification failed');
      if (d.status === 'linked') {
        setStep('email'); setEmail(''); setOtp(''); setNote('Email added as a sign-in method.');
        onLinked?.();
      } else if (d.status === 'issued' && d.token) {
        await openSession(d.token, 'email', false);
      } else if (d.status === 'bootstrap') {
        setErr('No home exists for this email yet — sign up with a passkey or Google first, then add email.');
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
