'use client';
// A HOUSEHOLD'S SECOND STEWARD (src/lib/household-steward-invitation.ts). Two modes, one relying-app request each:
//   invite  — a steward whose sign-in holds the household's keys signs the household's oversight grant TO the person the
//             app named (`issueSiteDelegation`, the founder's kind of grant) and Home records the invitation;
//   accept  — that person, in their own Home, accepts: their link to the household becomes a steward's.
// The app confirms by READING (its roster read), never by this window closing.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { issueSiteDelegation, toWire } from '../../../src/lib/delegation';
import { whitelabel } from '../../../src/whitelabel/config';
import { finishApprovalWindow } from '../../../src/lib/approval-window';
import { STEWARD_INVITATION_MESSAGE, parsePageRequest, type PageRequest } from '../../../src/lib/household-steward-invitation';

type Related = { orgs?: Array<{ orgAgent?: string; relationship?: string; orgName?: string; displayName?: string }> };
const relationOf = (b: Related, org: string) => (b.orgs ?? []).find((o) => String(o.orgAgent ?? '').toLowerCase() === org);

export default function HouseholdStewardInvitationPage() {
  const { session, agentAddress, agentName, personName, profile } = useSession();
  const [request, setRequest] = useState<PageRequest | null>(null);
  const [householdName, setHouseholdName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false), [stayed, setStayed] = useState(false);
  const [pending, setPending] = useState<{ label: string; invitedBy: string } | null | undefined>(undefined);
  // accept mode: what the person's OWN record says after the accept (the household's agent reads that, not Home's link)
  const [vaultStanding, setVaultStanding] = useState<'recorded' | 'not-recorded' | 'unreadable' | null>(null);
  useEffect(() => {
    const r = parsePageRequest(location.search, whitelabel.relyingApps);
    if (!r.ok) { setError(r.error); return; }
    setRequest(r.request);
  }, []);
  const me = agentAddress?.toLowerCase();
  const wrongHome = request?.mode === 'accept' && !!request.member && !!me && request.member !== me;
  const action = request?.mode === 'accept' ? 'accepted' : 'invited';
  const message = request && me ? { type: STEWARD_INVITATION_MESSAGE, org: request.household, person: request.mode === 'invite' ? request.person : me, action } : null;

  // the household's name, and (accept mode) the invitation waiting for this person
  useEffect(() => {
    if (!request || !session) return;
    let live = true;
    void fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30000) })
      .then((r) => r.json()).then((b: Related) => { const row = relationOf(b, request.household); const n = [row?.displayName, row?.orgName].find((x) => !!x && !/^0x[0-9a-f]{40}$/i.test(x.trim())); if (live && n) setHouseholdName(n); }).catch(() => {});
    if (request.mode === 'accept' && !wrongHome) {
      void fetch(`/connect/household-stewards?org=${request.household}`, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30000) })
        .then((r) => r.json()).then((b: { ok?: boolean; you?: string; invitations?: Array<{ invitee: string; state: string; label: string; invitedBy: string }> }) => {
          if (!live) return;
          // Already a steward at Home: accept once more (idempotent) so the person's OWN record is checked — and, for a
          // link recorded before the household grant was made to lead it, re-merged so it does.
          if (b.ok && b.you === 'steward') {
            const acceptedMine = (b.invitations ?? []).some((i) => i.invitee === me && i.state === 'accepted');
            if (!acceptedMine) { setDone(true); return; }
            void acceptNow().then(() => { if (live) setDone(true); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
            return;
          }
          const mine = (b.invitations ?? []).find((i) => i.invitee === me && i.state === 'pending');
          setPending(mine ? { label: mine.label, invitedBy: mine.invitedBy } : null);
        }).catch(() => { if (live) setPending(null); });
    }
    return () => { live = false; };
  }, [request, session?.token, me, wrongHome]);

  useEffect(() => {
    // a record that does not carry the grant yet keeps the window open: the person reads what to do about it
    if (!done || !request || !message || (vaultStanding && vaultStanding !== 'recorded')) return;
    const told = finishApprovalWindow(window, { targetOrigin: new URL(request.returnTo).origin, message, delayMs: 1500, onStillOpen: () => setStayed(true) });
    if (!told) setStayed(true);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE ACCEPT, then Home's own list must say steward; what the person's own record says comes back with it
  const acceptNow = async () => {
    if (!request || !session) return;
    const h = request.household as Address;
    const p = await fetch('/connect/household-stewards', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ action: 'accept', org: h }), signal: AbortSignal.timeout(30000) });
    const out = (await p.json()) as { ok?: boolean; error?: string; vaultStanding?: 'recorded' | 'not-recorded' | 'unreadable' };
    if (!p.ok || !out.ok) throw new Error(out.error ?? `Home answered ${p.status}.`);
    const r = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30000) });
    const b = (await r.json()) as Related;
    if (!r.ok || relationOf(b, h)?.relationship !== 'steward') throw new Error('Your acceptance was recorded, but Home does not list you as a steward yet. Return to the app and check before trying again.');
    setVaultStanding(out.vaultStanding ?? 'unreadable');
  };
  const approve = async () => {
    if (!request || !session || !me || busy || done || wrongHome) return;
    setBusy(true); setError('');
    try {
      const h = request.household as Address;
      if (request.mode === 'invite') {
        const r = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(30000) });
        const b = (await r.json()) as Related;
        if (!r.ok || relationOf(b, h)?.relationship === 'member' || !relationOf(b, h)) throw new Error('Home does not list you as a steward of this household, so you cannot invite a steward.');
        let delegation;
        try {
          const sign = await signHashFor(resolveVia(profile?.credential, session.via), h, { token: session.token });
          delegation = toWire(await issueSiteDelegation(h, request.person as Address, sign));
        } catch (e) {
          throw new Error(`The household’s grant could not be signed. Only someone whose sign-in holds this household’s keys can approve a new steward. Home said: ${e instanceof Error ? e.message : String(e)}`);
        }
        const p = await fetch('/connect/household-stewards', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ action: 'invite', org: h, invitee: request.person, label: request.label, ...(householdName || request.householdName ? { householdName: householdName || request.householdName } : {}), delegation }), signal: AbortSignal.timeout(30000) });
        const out = (await p.json()) as { ok?: boolean; error?: string };
        if (!p.ok || !out.ok) throw new Error(out.error ?? `Home answered ${p.status}.`);
      } else {
        await acceptNow();
      }
      setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  // the household's NAME (its link's, else the one the app showed), with the address beside it — never the address alone
  const household = householdName || request?.householdName || '';
  const back = () => { if (message) window.opener?.postMessage(message, new URL(request!.returnTo).origin); if (window.opener && !window.opener.closed) { window.opener.focus(); window.close(); } setTimeout(() => request && location.assign(request.returnTo), 150); };
  return <section style={{ maxWidth: 480, margin: '6vh auto', padding: 24 }}>
    <p>Approving as {personName ?? agentName ?? agentAddress ?? 'your Home'}</p>
    <h1>{done ? (request?.mode === 'accept' ? 'You’re a steward of this household' : 'Steward invitation approved') : request?.mode === 'accept' ? 'Become a steward of this household?' : 'Make them a steward?'}</h1>
    {request && !done && <>
      {request.mode === 'invite'
        ? <p>Invite <strong>{request.label}</strong> to be a steward of <strong>{household || 'this household'}</strong>, from {request.appName}.</p>
        : <p>{pending ? <>You were invited to be a steward of <strong>{household || 'this household'}</strong>.</> : pending === null ? 'Home has no steward invitation for you in this household.' : 'Looking for your invitation…'}</p>}
      <p>A steward can decide for the household: adopt its plan, change its description and settings, and invite others. Home signs a grant <em>from the household to {request.mode === 'invite' ? 'them' : 'you'}</em>; the household can revoke it.</p>
      {request.mode === 'invite' && <p>They still accept in their own Home. Only someone whose sign-in holds this household’s keys can approve this.</p>}
      <p>Household{household ? <> <strong>{household}</strong>, </> : ': '}<code style={{ overflowWrap: 'anywhere', fontSize: '0.85em' }}>{request.household}</code></p>
      {wrongHome && <p role="alert">This Home is signed in as a different person from the one invited. Return to the app and connect both windows with the same account.</p>}
      {busy && <p role="status">Saving your approval…</p>}
      <button type="button" className="btn primary" disabled={busy || wrongHome || !session || (request.mode === 'accept' && !pending)} onClick={() => void approve()}>{busy ? 'Saving…' : request.mode === 'accept' ? 'Accept and become a steward' : 'Approve steward invitation'}</button>
      <button className="btn" disabled={busy} onClick={() => window.close()}>Not now</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {done && request && vaultStanding === 'not-recorded' && <p role="alert">Home lists you as a steward, but your own record does not carry the household’s grant first yet, so {household || 'the household'}’s agent may still treat you as a member. Open this page again in a moment to finish it.</p>}
    {done && request && vaultStanding === 'unreadable' && <p role="alert">Home lists you as a steward, but your own record could not be read to confirm it (your Home storage session may have expired). Renew it on Home’s <a href="/enable-messaging">Enable messaging</a> page, then open this page again.</p>}
    {done && request && <><p role="status">{request.mode === 'accept' ? `Home lists you as a steward of ${household || 'this household'}.` : 'Invitation recorded. They must accept in their own Home.'} {vaultStanding && vaultStanding !== 'recorded' ? '' : stayed ? 'You can close this window.' : 'Taking you back…'}</p><button type="button" className="btn primary" onClick={back}>Done — back to the app</button></>}
  </section>;
}
