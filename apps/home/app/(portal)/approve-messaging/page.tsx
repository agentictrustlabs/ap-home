'use client';
// One-shot "approve this contact" ceremony for a relying app (Commons).
//
// The app can name the recipient and ask the agent to send. It cannot sign the
// wire — that credential is here. This page is the ceremony: approve, then return.
// KMS/email homes sign with no extra prompt; passkey/wallet homes get one device prompt.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { approveMessagingContact } from '../../../src/lib/messaging-ceremony';
import { resolveVia } from '../../../src/home/onboarding';
import { isAllowedRelyingOrigin } from '../../../src/lib/oidc-clients';
import { CONTRACTS } from '../../../src/lib/chain';
import { listManagedAgents } from '../../../src/connect-client';

const ADDR = /^0x[0-9a-f]{40}$/;

export default function ApproveMessagingPage() {
  const { session, agentAddress, agentName, profile, phase } = useSession();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [msg, setMsg] = useState('Approving…');
  const [ret, setRet] = useState('');
  const [label, setLabel] = useState('this contact');

  useEffect(() => {
    if (phase === 'restoring') return;
    const params = (() => {
      try { return new URL(window.location.href).searchParams; } catch { return null; }
    })();
    const to = (params?.get('to') ?? '').trim().toLowerCase();
    const name = (params?.get('n') ?? '').trim();
    const r = params?.get('return') || '';
    const back = r && isAllowedRelyingOrigin(r) ? r : '';
    setRet(back);
    setLabel(name || (ADDR.test(to) ? `${to.slice(0, 6)}…${to.slice(-4)}` : 'this contact'));
    if (!ADDR.test(to)) {
      setState('error');
      setMsg('This link did not name who to approve.');
      return;
    }
    if (!session || !agentAddress) {
      setState('error');
      setMsg('Sign in to your Home first, then open this link again.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // The re-mint carries the person's SCOPE CLASSES alongside the approved contact (spec 341
        // §5.1c) — wires minted before scope classes existed hold only exact addresses, and without
        // this the ceremony would repeat for every named counterparty and every co-member forever:
        //   · named → the name-registry entry ("any validly named agent"; the gate re-verifies BOTH
        //     names on-chain at send time, so this covers nobody once a name lapses);
        //   · their communities → each org they custody ("current members"; resolved live by the
        //     gate, so a kick severs reach instantly and a new joiner is reachable at once).
        // Org lookup is best-effort: a directory hiccup narrows the mint, never blocks the approval.
        const orgs = await listManagedAgents(session.token)
          .then((all) => all.filter((a) => a.kind === 'org').map((a) => a.agent.toLowerCase() as Address))
          .catch(() => [] as Address[]);
        await approveMessagingContact({
          person: agentAddress as Address,
          recipients: [
            to as Address,
            ...(agentName?.trim() ? [CONTRACTS.agentNameRegistry.toLowerCase() as Address] : []),
            ...orgs,
          ],
          via: resolveVia(profile?.credential, session.via),
          token: session.token,
        });
        if (cancelled) return;
        setState('done');
        setMsg(`Your agent may message ${name || 'them'} now.`);
        if (back) setTimeout(() => { window.location.href = back; }, 800);
      } catch (e) {
        if (cancelled) return;
        setState('error');
        setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [phase, session, agentAddress, agentName, profile?.credential]);

  return (
    <div style={{ maxWidth: 460, margin: '10vh auto', padding: '0 20px', textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, marginBottom: 10 }}>Approve {label}</h1>
      {state === 'working' && (
        <p style={{ opacity: 0.8 }}>
          One signature lets your agent message them. You can revoke it anytime.
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
