'use client';
// Phone (SMS) sign-in / add-phone card (phone-auth, spec 320). Two-step: enter phone → get an SMS code →
// verify. Behavior mirrors EmailAuthCard: signed-in ⇒ LINK (add phone as a login/recovery method),
// anonymous ⇒ ISSUE a session (or BOOTSTRAP a KMS-custodied home if there's no home for that phone yet).
// SMS proves telecom-address control (contact-control), not custody — after a bootstrap the durable
// credential is a passkey (add one from Security & Recovery).
//
// Input is FLEXIBLE (server normalizes to E.164): US numbers format as-you-type — (303) 944-8008 —
// and international numbers pass through with their leading +. autoComplete="tel" /
// "one-time-code" keep the OS keyboard + SMS autofill working; the code auto-verifies on digit 6.
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { secureHomeNoName, activateVault } from '../../home/onboarding';
import { seedImpactProfileFields } from '../../profile-store';

/** As-you-type display formatting for NANP numbers; anything led by `+` (or too long) is left alone. */
function formatPhoneInput(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('+')) return `+${t.slice(1).replace(/[^\d\s()-]/g, '')}`;
  const d = t.replace(/\D/g, '');
  const nat = d.startsWith('1') && d.length > 10 ? d.slice(1) : d;
  const lead = d.startsWith('1') && d.length > 10 ? '1 ' : '';
  if (nat.length > 10) return t; // not NANP — leave whatever they're typing
  if (nat.length > 6) return `${lead}(${nat.slice(0, 3)}) ${nat.slice(3, 6)}-${nat.slice(6)}`;
  if (nat.length > 3) return `${lead}(${nat.slice(0, 3)}) ${nat.slice(3)}`;
  return lead + nat;
}

const RESEND_SECONDS = 30;

export function PhoneAuthCard({ onLinked }: { onLinked?: () => void }) {
  const { session, openSession } = useSession();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const verifying = useRef(false);
  const phoneRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  const start = async (resend = false) => {
    setBusy(true); setErr(null); if (!resend) setNote(null);
    try {
      const r = await fetch('/connect/phone/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string; devCode?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'could not send the code');
      setStep('code');
      setOtp('');
      setCooldown(RESEND_SECONDS);
      setNote(d.delivery === 'logged'
        ? (d.devCode ? `SMS isn’t configured (dev) — your code is ${d.devCode}.` : 'SMS isn’t configured yet — the code was logged server-side (dev).')
        : `We texted a 6-digit code to ${phone.trim()}.${resend ? ' (new code sent)' : ''}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const verify = async (code?: string) => {
    if (verifying.current) return;
    verifying.current = true;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/connect/phone/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {}) },
        body: JSON.stringify({ phone: phone.trim(), otp: (code ?? otp).trim() }),
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
          const res = await secureHomeNoName({ token: d.token }, { claimPendingNameVia: 'phone' });
          if (!res.ok) throw new Error(res.error);
          void activateVault(res.home.address, 'phone', { token: d.token }); // spec 278 — best-effort vault
        }
        const p = await openSession(d.token, 'phone', false);
        onLinked?.();
        // Metadata-tiers doctrine: the VERIFIED phone number is tier-1 PII — seed the private vault
        // profile (fill-only-empty, best-effort; the member edits/removes it on /profile anytime).
        const addr = p?.agent?.split(':').pop();
        if (addr) void seedImpactProfileFields(addr as `0x${string}`, { phone: phone.trim() });
      } else if (d.status === 'bootstrap') {
        setErr('We couldn’t set up a home for this number automatically — sign up with a passkey or Google, then add phone.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setOtp('');
    } finally { setBusy(false); verifying.current = false; }
  };

  const onOtpChange = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setOtp(digits);
    if (digits.length === 6 && !busy) void verify(digits);
  };

  return (
    <div style={{ maxWidth: 380 }}>
      {step === 'phone' ? (
        <>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <input
              ref={phoneRef}
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              aria-label="Phone number"
              data-testid="phone-auth-input"
              placeholder="(303) 555-1234"
              value={phone}
              onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
              onKeyDown={(e) => { if (e.key === 'Enter' && phone.trim()) void start(); }}
              style={{ flex: 1, minWidth: 200, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8 }}
            />
            <button className="btn" data-testid="phone-auth-continue" disabled={busy || !phone.trim()} onClick={() => void start()}>
              {busy ? 'Sending…' : session ? 'Add phone' : 'Text me a code'}
            </button>
          </div>
          <p style={{ fontSize: '.75rem', color: 'var(--color-text-muted)', margin: '.4rem 0 0' }}>
            US numbers work as-is. Elsewhere, start with <b>+</b> and your country code.
          </p>
        </>
      ) : (
        <>
          <p style={{ fontSize: '.85rem', margin: '0 0 .5rem' }}>
            Enter the 6-digit code sent to <b>{phone.trim()}</b>.
          </p>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit verification code"
              data-testid="phone-auth-code"
              placeholder="••••••"
              value={otp}
              onChange={(e) => onOtpChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && otp.length === 6) void verify(); }}
              autoFocus
              style={{ width: 130, padding: '.5rem .7rem', border: '1px solid var(--color-border-strong)', borderRadius: 8, letterSpacing: '4px', fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}
            />
            <button className="btn" data-testid="phone-auth-verify" disabled={busy || otp.length < 6} onClick={() => void verify()}>
              {busy ? 'Checking…' : 'Verify'}
            </button>
          </div>
          <p style={{ fontSize: '.78rem', margin: '.5rem 0 0', display: 'flex', gap: '.9rem' }}>
            <button
              type="button"
              className="btn-ghost"
              data-testid="phone-auth-resend"
              disabled={busy || cooldown > 0}
              onClick={() => void start(true)}
              style={{ padding: 0, fontSize: 'inherit' }}
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setStep('phone'); setOtp(''); setErr(null); setNote(null); phoneRef.current?.focus(); }}
              style={{ padding: 0, fontSize: 'inherit' }}
            >
              Change number
            </button>
          </p>
        </>
      )}
      <p data-testid="phone-auth-note" aria-live="polite" style={{ fontSize: '.78rem', color: 'var(--color-text-muted)', margin: '.5rem 0 0', minHeight: note ? undefined : 0 }}>{note}</p>
      {err && <p data-testid="phone-auth-error" role="alert" aria-live="assertive" style={{ fontSize: '.78rem', color: 'var(--color-danger)', margin: '.5rem 0 0' }}>{err}</p>}
    </div>
  );
}
