'use client';
// BE FRIENDS WHEN THEY ACCEPT — opened by an app right after it sent a friend invitation by email
// (`/friend-invitation?t=<token>&from=<app>`). The invitation itself carries no authority; this is the inviter's own
// half of the friendship, signed now (src/home/friend-invitation.ts), so accepting makes them friends in one step.
// "Not now" leaves the invitation as it was: they become friends when the inviter adds them back by hand.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { sentInvitation, signInvitationHalf, type SentInvitation } from '../../../src/home/friend-invitation';

export default function FriendInvitationPage() {
  const { session, agentAddress, profile } = useSession();
  const [inv, setInv] = useState<SentInvitation | null>(null);
  const [app, setApp] = useState('the app');
  const [state, setState] = useState<'loading' | 'ready' | 'signing' | 'done' | 'error'>('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!session || !agentAddress) return;
    const q = new URLSearchParams(window.location.search);
    const token = q.get('t') ?? '';
    const from = (q.get('from') ?? '').trim();
    if (from) setApp(from === 'seed-reader' ? 'Seed Bible' : from);
    void sentInvitation(session, token)
      .then((found) => {
        if (!found) throw new Error('This invitation is not one of yours, or it has expired.');
        if (found.acceptedBy) throw new Error(`${found.email} has already accepted — add them back from your friends.`);
        setInv(found);
        setState('ready');
      })
      .catch((e: unknown) => { setMsg(e instanceof Error ? e.message : String(e)); setState('error'); });
  }, [session, agentAddress]);

  const sign = async () => {
    if (!inv || !session || !agentAddress) return;
    setState('signing');
    try {
      const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agentAddress as Address, { token: session.token });
      const out = await signInvitationHalf({ session, token: inv.token, expiresAt: inv.expiresAt, signHash });
      if (!out.ok) throw new Error(out.error);
      setState('done');
      setTimeout(() => window.close(), 1200);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };

  return (
    <div style={{ maxWidth: 440, margin: '6vh auto', padding: '0 20px' }} data-testid="friend-invitation">
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>Be friends when they accept?</h1>
      {state === 'loading' && <p>Getting it ready…</p>}
      {(state === 'ready' || state === 'signing') && inv && (
        <>
          <p style={{ opacity: 0.8, marginTop: 0 }}>
            {app} sent your invitation to <b>{inv.email}</b>. Say yes now and you are friends the moment they accept — nothing more to do later.
          </p>
          <p style={{ opacity: 0.7, fontSize: 14 }}>
            Friends can see your profile (your name, photo and the line about you). This holds only for whoever accepts this one invitation, and you can remove them as a friend at any time.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn primary" disabled={state === 'signing'} onClick={() => void sign()} data-testid="friend-invitation-yes">
              {state === 'signing' ? 'Saving…' : 'Yes, be friends when they accept'}
            </button>
            <button type="button" className="btn" disabled={state === 'signing'} onClick={() => window.close()}>Not now</button>
          </div>
        </>
      )}
      {state === 'done' && <p style={{ fontWeight: 600 }} data-testid="friend-invitation-done">Done — you will be friends when they accept. Taking you back.</p>}
      {state === 'error' && (
        <>
          <p role="alert">{msg}</p>
          <button type="button" className="btn" onClick={() => window.close()}>Close</button>
        </>
      )}
    </div>
  );
}
