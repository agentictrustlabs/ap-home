'use client';
// Google-home rotation panel — shown only for Google-signed-in homes. Extracted from the old /you
// "Security" tab so it can live on the Security page (spec 315 nav: settings surfaces are real routes).
import { useState } from 'react';
import { useSession } from '../../../context/session';
import { continueWithGoogle } from '../../../home/onboarding';
import { rotateGoogleHome } from '../../../server-client';
import { SettingsGroup } from './SettingsLayout';

export function GoogleSignInPanel() {
  const { session } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (session?.via !== 'Google') return null;

  async function newHome() {
    if (!session) return;
    setBusy(true);
    setErr('');
    try {
      await rotateGoogleHome(session.token);
      continueWithGoogle();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not start a new home');
      setBusy(false);
    }
  }

  return (
    <SettingsGroup label="Sign-in">
      <div className="settings-banner settings-banner--warn" style={{ margin: '0.75rem 1rem 0.5rem', borderRadius: 8 }}>
        <div>
          <strong>Google sign-in</strong>
          <p style={{ margin: '0.3rem 0 0.5rem', fontSize: '0.8rem' }}>
            This home opens with Google. Add a passkey to reduce reliance on Google alone.
          </p>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void newHome()}>
            {busy ? 'Starting…' : 'Use Google for a new home'}
          </button>
          {err && <p style={{ color: 'var(--color-danger)', fontSize: '0.78rem', margin: '0.35rem 0 0' }}>{err}</p>}
        </div>
      </div>
    </SettingsGroup>
  );
}
