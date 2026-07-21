'use client';
// Email sign-in / add-email card (email-auth Phase 1b). Two-step: enter email → get a 6-digit code →
// verify. Behavior depends on whether there's a session: signed-in ⇒ LINK (add email as a login method),
// anonymous ⇒ ISSUE a login-grade session (or BOOTSTRAP if there's no home for that email yet).
//
// EXISTING-HOME INTERSTITIAL (live 2026-07-20, psk-4): one email = ONE canonical home (ADR-0010 —
// the KMS sub is SHA-256(email)), so verifying an already-bound email OPENS that home; it can never
// found a second one. Previously that silently dropped the name the member chose in the journey
// (`pendingHomeName`) and dumped them into the old (often nameless) home with no explanation. Now,
// when a chosen name is pending and the email resolves to an existing home, the member decides:
// continue into the existing home (optionally claiming the chosen name for it when it has none), or
// go back and use a different email for the new named home.
import { useState } from 'react';
import { useSession } from '../../context/session';
import { secureHomeNoName, activateVault, signHashFor } from '../../home/onboarding';
import { claimName, fetchProfile } from '../../connect-client';
import { nameLabel } from '../../lib/domain';
import { seedImpactProfileFields } from '../../profile-store';
import type { Address } from '@agenticprimitives/types';

export function EmailAuthCard({ onLinked }: { onLinked?: () => void }) {
  const { session, openSession } = useSession();
  const [step, setStep] = useState<'email' | 'code' | 'existing-home'>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The issued token held while the member decides between their EXISTING home and the name they
   *  chose (see the existing-home interstitial below). */
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [chosenName, setChosenName] = useState<string>('');
  const [existingName, setExistingName] = useState<string>('');
  const [existingAddr, setExistingAddr] = useState<string>('');

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

  /** Open the session + seed the verified email (the shared tail of every issued path). */
  const finishSignIn = async (token: string) => {
    const p = await openSession(token, 'email', false);
    onLinked?.();
    // Metadata-tiers doctrine: the VERIFIED email is tier-1 PII — seed the private vault profile
    // (fill-only-empty, best-effort; the member edits/removes it on /profile anytime).
    const addr = p?.agent?.split(':').pop();
    if (addr) void seedImpactProfileFields(addr as `0x${string}`, { email: email.trim().toLowerCase() });
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
          await finishSignIn(d.token);
          return;
        }
        // EXISTING home (this email is already bound to a canonical SA — ADR-0010: it opens that home,
        // never founds a second). If the member chose a name in this journey, don't silently drop it:
        // show the interstitial so they decide (continue / name the home / different email).
        const pending = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('pendingHomeName') : null;
        if (pending) {
          const profile = await fetchProfile(d.token);
          const already = profile?.name ?? '';
          const chosen = nameLabel(pending) || pending;
          if (already && (nameLabel(already) || already) === (nameLabel(pending) || pending)) {
            // The existing home IS the chosen name — nothing to decide.
            sessionStorage.removeItem('pendingHomeName');
            await finishSignIn(d.token);
            return;
          }
          setPendingToken(d.token);
          setChosenName(chosen);
          setExistingName(already);
          setExistingAddr(profile?.agent?.split(':').pop() ?? '');
          setStep('existing-home');
          return;
        }
        await finishSignIn(d.token);
      } else if (d.status === 'bootstrap') {
        setErr('We couldn’t set up a home for this email automatically — sign up with a passkey or Google, then add email.');
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  /** Interstitial action — continue into the existing home as-is (drop the chosen name). */
  const continueExisting = async () => {
    if (!pendingToken) return;
    setBusy(true); setErr(null);
    try {
      sessionStorage.removeItem('pendingHomeName');
      await finishSignIn(pendingToken);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  /** Interstitial action — the existing home has NO name: claim the chosen one for it (KMS-signed,
   *  zero prompts), then sign in. One-name-per-SA is enforced by claimName's no-op guard. */
  const claimForExisting = async () => {
    if (!pendingToken || !existingAddr || !chosenName) return;
    setBusy(true); setErr(null);
    try {
      setNote(`Claiming ${chosenName}…`);
      const sign = await signHashFor('email', existingAddr as Address, { token: pendingToken });
      const res = await claimName(existingAddr as Address, sign, chosenName);
      if (!res.ok) throw new Error(res.error);
      sessionStorage.removeItem('pendingHomeName');
      setNote(null);
      await finishSignIn(pendingToken);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 380 }}>
      {step === 'existing-home' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
          <p style={{ fontSize: '.85rem', margin: 0, lineHeight: 1.5 }}>
            <strong>{email.trim()}</strong> already opens a home
            {existingName ? <> named <strong>{existingName}</strong></> : <> ({existingAddr ? `${existingAddr.slice(0, 6)}…${existingAddr.slice(-4)}` : 'unnamed'})</>}.
            An email can only ever open its own home, so <strong>{chosenName}</strong> can&rsquo;t be created with it.
          </p>
          {!existingName && chosenName && (
            <button className="btn-primary" disabled={busy} onClick={() => void claimForExisting()}>
              {busy ? '…' : `Name that home ${chosenName} and continue`}
            </button>
          )}
          <button className={!existingName && chosenName ? 'btn' : 'btn-primary'} disabled={busy} onClick={() => void continueExisting()}>
            {busy ? '…' : `Continue as ${existingName || 'that home'}`}
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => { setStep('email'); setEmail(''); setOtp(''); setPendingToken(null); setErr(null); setNote(null); }}>
            Use a different email for {chosenName}
          </button>
        </div>
      ) : step === 'email' ? (
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
