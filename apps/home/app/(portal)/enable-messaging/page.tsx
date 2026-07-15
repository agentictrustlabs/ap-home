'use client';
// One-click messaging enablement for a relying app (the uupg tracker). A relying app can't provision the
// person's messaging planes itself (that needs the person's Home credential), so it links here with
// `?return=<app-url>`. Using the signed-in Home session, we provision BOTH planes the send path needs —
// the INTERACTIONS grant (conversation.index / inbox.data writes) AND the inbox-DELIVERY grant (body
// residency) — then bounce back. Zero-prompt for KMS (google/youversion/email/phone) homes; a passkey/
// wallet home signs on device. Idempotent: activate* skip when already granted.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { activateInteractionsIfNeeded, activateInboxDeliveryIfNeeded, isKmsVia, type Via } from '../../../src/home/onboarding';
import { isAllowedRelyingOrigin } from '../../../src/lib/oidc-clients';

export default function EnableMessagingPage() {
  const { session, agentAddress, phase } = useSession();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [msg, setMsg] = useState('Turning on messaging…');
  const [ret, setRet] = useState<string>('');

  useEffect(() => {
    if (phase === 'restoring') return;
    const r = (() => { try { return new URL(window.location.href).searchParams.get('return') || ''; } catch { return ''; } })();
    setRet(r && isAllowedRelyingOrigin(r) ? r : '');
    if (!session || !agentAddress) { setState('error'); setMsg('Sign in to your Home first, then retry.'); return; }
    let cancelled = false;
    void (async () => {
      // Normalize the via: the session stores the display form ('Google'/'YouVersion' from the OAuth
      // callback), but isKmsVia/signHashFor match lowercase — without this a SOCIAL home falls through to
      // the passkey signer and (wrongly) prompts a device challenge instead of signing gesture-free via KMS.
      const via = (String(session.via ?? '').toLowerCase() || 'passkey') as Via;
      const auth = isKmsVia(via) ? { token: session.token } : undefined;
      // Interactions first (the inbox doc plane), then delivery (the body plane). FORCE re-issue both so a
      // grant minted before the current resource scope (which /status can't detect — it reports presence,
      // not scope-currency) is refreshed; a stale delivery scope is what makes a DM send `record_scope_denied`.
      const a = await activateInteractionsIfNeeded(agentAddress as Address, via, auth, true);
      const b = await activateInboxDeliveryIfNeeded(agentAddress as Address, via, auth, true);
      if (cancelled) return;
      if (!a.ok || !b.ok) {
        setState('error');
        setMsg([a.ok ? '' : `interactions: ${a.error}`, b.ok ? '' : `delivery: ${b.error}`].filter(Boolean).join(' · ') || 'could not enable messaging');
        return;
      }
      setState('done');
      setMsg('Messaging is on.');
      if (r && isAllowedRelyingOrigin(r)) setTimeout(() => { window.location.href = r; }, 1100);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session, agentAddress]);

  return (
    <div style={{ maxWidth: 460, margin: '10vh auto', padding: '0 20px', textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, marginBottom: 10 }}>Messaging</h1>
      {state === 'working' && <p style={{ opacity: 0.8 }}>{msg}</p>}
      {state === 'done' && (
        <>
          <p style={{ color: 'var(--color-success, #178a4c)' }}>{msg}</p>
          <p style={{ opacity: 0.8, marginTop: 8 }}>{ret ? 'Returning to the app…' : 'You can return to the app now.'}</p>
        </>
      )}
      {state === 'error' && (
        <>
          <p style={{ color: 'var(--color-danger, #b3261e)' }}>{msg}</p>
          {ret && <p style={{ marginTop: 12 }}><a href={ret}>← Back to the app</a></p>}
        </>
      )}
    </div>
  );
}
