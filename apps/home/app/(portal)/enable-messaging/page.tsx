'use client';
// One-click messaging enablement for a relying app (the uupg tracker). A relying app can't provision the
// person's messaging planes itself (that needs the person's Home credential), so it links here with
// `?return=<app-url>`. Using the signed-in Home session, we FORCE-provision BOTH planes the send path needs
// — the INTERACTIONS grant (conversation.index / inbox.data writes) AND the inbox-DELIVERY grant (dm body
// residency) — for the PERSON *and every org they steward*. Force is required because /status reports only
// grant PRESENCE, not scope-currency: a grant minted before a resource-scope change (e.g. the dm-body write
// scope) stays stale and causes `record_scope_denied` on send — and sendFromInbox writes the RECIPIENT's
// inbox first, so a stale grant on the org you're messaging fails just as hard as a stale one on you.
// Zero-prompt for KMS (google/youversion/email/phone) homes; a passkey/wallet home signs on device.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { useManagedAgents } from '../../../src/components/portal/ManagedAgents';
import { activateInteractionsIfNeeded, activateInboxDeliveryIfNeeded, isKmsVia, type Via } from '../../../src/home/onboarding';
import { isAllowedRelyingOrigin } from '../../../src/lib/oidc-clients';

export default function EnableMessagingPage() {
  const { session, agentAddress, phase } = useSession();
  const { agents, loaded } = useManagedAgents(session?.token ?? null);
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [msg, setMsg] = useState('Turning on messaging…');
  const [ret, setRet] = useState<string>('');

  useEffect(() => {
    if (phase === 'restoring') return;
    const r = (() => { try { return new URL(window.location.href).searchParams.get('return') || ''; } catch { return ''; } })();
    setRet(r && isAllowedRelyingOrigin(r) ? r : '');
    if (!session || !agentAddress) { setState('error'); setMsg('Sign in to your Home first, then retry.'); return; }
    if (!loaded) return; // wait for the stewarded-orgs list before provisioning them too
    let cancelled = false;
    void (async () => {
      // Normalize via: the session stores the display form ('Google'/'YouVersion' from the OAuth callback),
      // but isKmsVia/signHashFor match lowercase — without this a SOCIAL home falls through to the passkey
      // signer and prompts a device challenge instead of signing gesture-free via KMS.
      const via = (String(session.via ?? '').toLowerCase() || 'passkey') as Via;
      const auth = isKmsVia(via) ? { token: session.token } : undefined;
      // Principals to refresh: the person + every ORG they STEWARD (custodial control — a 'member' link is
      // authority-only and its owner enables its own planes). The person's credential custodies these orgs
      // (org-create deploys them under the same custodian), so it can sign their grants.
      const orgs = agents.filter((a) => a.kind === 'org' && a.relationship !== 'member').map((a) => a.agent as Address);
      const principals: Address[] = [agentAddress as Address, ...orgs];
      const failures: string[] = [];
      for (const p of principals) {
        const a = await activateInteractionsIfNeeded(p, via, auth, true);
        const b = await activateInboxDeliveryIfNeeded(p, via, auth, true);
        if (!a.ok) failures.push(`${p.slice(0, 10)}… interactions: ${a.error}`);
        if (!b.ok) failures.push(`${p.slice(0, 10)}… delivery: ${b.error}`);
      }
      if (cancelled) return;
      if (failures.length) { setState('error'); setMsg(failures.join(' · ')); return; }
      setState('done');
      setMsg(`Messaging is on for you${orgs.length ? ` and ${orgs.length} organization${orgs.length === 1 ? '' : 's'}` : ''}.`);
      if (r && isAllowedRelyingOrigin(r)) setTimeout(() => { window.location.href = r; }, 1200);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session, agentAddress, loaded]);

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
          <p style={{ color: 'var(--color-danger, #b3261e)', wordBreak: 'break-word' }}>{msg}</p>
          {ret && <p style={{ marginTop: 12 }}><a href={ret}>← Back to the app</a></p>}
        </>
      )}
    </div>
  );
}
