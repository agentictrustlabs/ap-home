'use client';
// One-shot "this app may read my inbox" ceremony for a relying app (Commons).
//
// Connecting proves who you are. Reading your mail is a different yes: a scoped, read-only,
// revocable grant for that app alone. The app cannot sign it — the credential is here.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { isAllowedRelyingOrigin } from '../../../src/lib/oidc-clients';
import { INTERACTIONS_SERVICE_SA, MCP_SERVER_ID } from '../../../src/lib/inbox-delivery';
import { INBOX_READ_RESOURCES, issueReadGrant, putReadGrant } from '../../../src/lib/read-grants';

const CLIENT = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

export default function ApproveInboxReadPage() {
  const { session, agentAddress, profile, phase } = useSession();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [msg, setMsg] = useState('Authorizing…');
  const [ret, setRet] = useState('');
  const [app, setApp] = useState('this app');

  useEffect(() => {
    if (phase === 'restoring') return;
    const params = (() => {
      try { return new URL(window.location.href).searchParams; } catch { return null; }
    })();
    const clientId = (params?.get('app') ?? '').trim().toLowerCase();
    const r = params?.get('return') || '';
    const back = r && isAllowedRelyingOrigin(r) ? r : '';
    setRet(back);
    setApp(clientId || 'this app');
    if (!CLIENT.test(clientId)) {
      setState('error');
      setMsg('This link did not name which app to authorize.');
      return;
    }
    if (!session || !agentAddress) {
      setState('error');
      setMsg('Sign in to your Home first, then open this link again.');
      return;
    }
    if (!INTERACTIONS_SERVICE_SA) {
      setState('error');
      setMsg('This deployment has no interactions service agent, so a read grant would be inert.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agentAddress as Address, {
          token: session.token,
        });
        const grant = await issueReadGrant({
          personSA: agentAddress as Address,
          serviceSA: INTERACTIONS_SERVICE_SA,
          resources: INBOX_READ_RESOURCES,
          server: MCP_SERVER_ID,
          signHash,
        });
        await putReadGrant(agentAddress as Address, clientId, grant);
        if (cancelled) return;
        setState('done');
        setMsg(`${clientId} may read your inbox now. You can revoke that for this app alone.`);
        if (back) setTimeout(() => { window.location.href = back; }, 800);
      } catch (e) {
        if (cancelled) return;
        setState('error');
        setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [phase, session, agentAddress, profile?.credential]);

  return (
    <div style={{ maxWidth: 460, margin: '10vh auto', padding: '0 20px', textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, marginBottom: 10 }}>Let {app} read your messages</h1>
      {state === 'working' && (
        <p style={{ opacity: 0.8 }}>
          One signature, read-only, for this app only. It cannot send, edit, or delete. You can revoke it anytime.
        </p>
      )}
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
