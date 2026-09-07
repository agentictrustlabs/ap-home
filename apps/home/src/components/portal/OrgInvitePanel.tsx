'use client';
// Org enrollment — the ONE invite surface (spec 324 §12). Extracted from the standalone /org/<sa>/invite page
// so it mounts inside the Members section: the two invite paths (existing named agent via KB search, or anyone
// by email link) live with the roster, not on a separate page. Both pre-sign the org→invitee member-access
// grant (best-effort) and end in the invitee publishing their own self-signed listing (ADR-0025 — the invite
// never enrolls on their behalf).
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { inviteThroughHarness } from '../../home/invite-harness';
import { sendMessage, MessagingWireRequiredError } from '../../lib/messaging-send';
import { approveMessagingContact, COMMUNITY_MESSAGING_VALIDITY_SECONDS } from '../../lib/messaging-ceremony';
import { ApproveMessaging } from './ApproveMessaging';
import { searchAgentsKb, type AgentSearchHit } from '../../lib/agent-search';
import { Avatar } from './chat/Avatar';
import { BusyButton } from '../shared/BusyButton';
import { signHashFor, resolveVia } from '../../home/onboarding';
import { issueOrganizationResourceAccessDelegation, toWire, type DelegationWire } from '../../lib/delegation';
import { CONTRACTS } from '../../lib/chain';
import { MCP_SERVER_ID } from '../../lib/inbox-delivery';

/** Steward arrived from a relying app — send invitees back there after they join.
 *  Stash on the org so a later client nav that drops `?return=&app=` still records the app. */
function inviteReturnFromPage(org: string): { returnUrl?: string; app?: string } {
  if (typeof window === 'undefined') return {};
  const key = `ap:invite-dest:${org.toLowerCase()}`;
  const p = new URLSearchParams(window.location.search);
  const returnUrl = p.get('return') ?? p.get('returnUrl') ?? undefined;
  const app = p.get('app') ?? undefined;
  if (returnUrl || app) {
    try { sessionStorage.setItem(key, JSON.stringify({ returnUrl, app })); } catch { /* blocked */ }
    return { ...(returnUrl ? { returnUrl } : {}), ...(app ? { app } : {}) };
  }
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) return JSON.parse(raw) as { returnUrl?: string; app?: string };
  } catch { /* blocked or malformed */ }
  return {};
}

export function OrgInvitePanel({ org }: { org: string }) {
  const { session, profile, agentAddress, agentName } = useSession();
  const dest = inviteReturnFromPage(org);
  // spec 341 §5.1b — an invite blocked only for want of the person's approval.
  const [wireNeeded, setWireNeeded] = useState<MessagingWireRequiredError | null>(null);
  const communityId = org.toLowerCase();
  const authed = { 'content-type': 'application/json', authorization: `Bearer ${session?.token ?? ''}` };

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AgentSearchHit[] | null>(null);
  const [email, setEmail] = useState(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('email')?.trim() ?? '';
  });
  const [busy, setBusy] = useState(false);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setHits(await searchAgentsKb(query.trim()).catch(() => []));
  }, [query]);

  const inviteAgent = useCallback(async (hit: AgentSearchHit) => {
    if (!session) return;
    setBusy(true); setBusyFor(hit.name); setErr(null); setNote(null);
    let grantNote = '';
    try {
      // THE GOVERNED CORE GOES THROUGH THE HARNESS — spec 361 I4, execution parity's screen side. This
      // button and the words "invite X to this team" now reach ONE implementation: the screen submits a
      // supplied plan (a click is not a sentence — no model re-derives it), the reply names both digests,
      // and mintApprovedMandate approveHashes mandate + grant in one org userOp: ONE signature, same as
      // the direct pre-sign this replaces, with the mandate the Ask path always required now covered by
      // the same prompt instead of skipped. Best-effort exactly as before — a failed grant still sends a
      // valid (grant-less) invite, and the note says so.
      try {
        const via = resolveVia(profile?.credential, session.via);
        const sign = await signHashFor(via, communityId as Address, { token: session.token });
        const out = await inviteThroughHarness({
          org: communityId as Address, invitee: hit.smartAgent as Address,
          session: { token: session.token }, signHash: sign,
        });
        if (!out.ok) throw new Error(out.error);
        if (!out.recorded) grantNote = ' (issued; the vault record could not be stored — it can be re-sent)';
      } catch (e) {
        grantNote = ` (without a pre-signed access grant: ${e instanceof Error ? e.message : String(e)})`;
      }
      // spec 341 §5.1b — delivered by the inviter's own agent over A2A, not written by the Home.
      // One signature covers the invitee (explicitly — they may not be a member yet), this community
      // (its current members, resolved live at the gate), and — for a named steward — anyone named.
      if (!agentAddress) throw new Error('no agent address');
      const via = resolveVia(profile?.credential, session.via);
      await approveMessagingContact({
        person: agentAddress,
        recipients: [
          hit.smartAgent.toLowerCase() as Address,
          communityId as Address,
          ...(agentName?.trim() ? [CONTRACTS.agentNameRegistry.toLowerCase() as Address] : []),
        ],
        via,
        token: session.token,
        validitySeconds: COMMUNITY_MESSAGING_VALIDITY_SECONDS,
      });
      await sendMessage({
        person: agentAddress,
        recipientName: hit.name,
        bodyText: `You're invited to join this organization. Open the "Join" chip on this message to accept — you'll sign a listing you can revoke anytime.`,
        contextRefs: [{ kind: 'org-channels', id: communityId, label: 'Join the organization' }],
      });
      setNote(`Invitation sent to ${hit.displayName ?? hit.name}.` + grantNote);
      setQuery(''); setHits(null);
    } catch (e) {
      if (e instanceof MessagingWireRequiredError) setWireNeeded(e);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setBusyFor(null); }
  }, [authed, communityId, profile?.credential, session]);

  const inviteEmail = useCallback(async () => {
    if (!email.trim() || !session) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const addr = email.trim().toLowerCase();
      let memberAccessDelegation: DelegationWire | undefined;
      let grantNote = '';
      try {
        const pr = await fetch('/connect/org-invite/predict', {
          method: 'POST', headers: authed, body: JSON.stringify({ org: communityId, email: addr }),
        });
        const pb = (await pr.json().catch(() => ({}))) as { ok?: boolean; agent?: Address; error?: string };
        if (!pr.ok || !pb.ok || !pb.agent) throw new Error(pb.error ?? `predict failed (${pr.status})`);
        const via = resolveVia(profile?.credential, session.via);
        const sign = await signHashFor(via, communityId as Address, { token: session.token });
        memberAccessDelegation = toWire(await issueOrganizationResourceAccessDelegation(communityId as Address, pb.agent, MCP_SERVER_ID, sign));
      } catch (e) {
        grantNote = ` (without a pre-signed access grant: ${e instanceof Error ? e.message : String(e)})`;
      }
      if (agentAddress && memberAccessDelegation) {
        const via = resolveVia(profile?.credential, session.via);
        const invited = (memberAccessDelegation.delegate ?? '').toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(invited)) {
          await approveMessagingContact({
            person: agentAddress,
            recipients: [
              invited as Address,
              communityId as Address,
              ...(agentName?.trim() ? [CONTRACTS.agentNameRegistry.toLowerCase() as Address] : []),
            ],
            via,
            token: session.token,
            validitySeconds: COMMUNITY_MESSAGING_VALIDITY_SECONDS,
          });
        }
      }
      // ONE FLOW (spec 367 §7): the email invite is the SAME capability the sentence and the agent button use —
      // the harness predicts the agent this email's Home will hold, signs the organization's grant to it in
      // the one-prompt ceremony, and delivers the link by mail from the organization as the act's effect.
      const via = resolveVia(profile?.credential, session.via);
      const sign = await signHashFor(via, communityId as Address, { token: session.token });
      const out = await inviteThroughHarness({ org: communityId as Address, invitee: addr, session: { token: session.token }, signHash: sign });
      if (!out.ok) throw new Error(out.error);
      const d = out.emailDelivery;
      setNote((!d ? `Invited — the agent did not report the email delivery.` : !d.ok ? `The invitation was recorded, but the email did not go: ${d.error ?? 'delivery failed'}.` : d.delivery === 'logged'
        ? `Email sending isn't configured yet — the invite link was logged server-side (dev).`
        : `Invitation emailed to ${email.trim()} from this organization.`) + grantNote);
      setEmail('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [authed, communityId, dest.app, dest.returnUrl, email, profile?.credential, session?.via, session?.token]);

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 className="subhead" style={{ marginBottom: '.6rem' }}>
        {dest.app ? `Invite to ${dest.app === 'commons-app' ? 'Commons' : dest.app}` : 'Invite people'}
      </h3>
      <ApproveMessaging
        need={wireNeeded}
        person={agentAddress ?? null}
        session={session}
        credential={profile?.credential}
        onApproved={() => setWireNeeded(null)}
        onError={setErr}
      />
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '.82rem' }}>{err}</p>}
      {note && <p style={{ color: 'var(--color-sage-700, #047857)', fontSize: '.82rem' }}>{note}</p>}

      <div className="dash-section" style={{ maxWidth: 560 }}>
        <h2>Invite an existing member</h2>
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .6rem' }}>
          Someone already in the naming service — they get an in-app invitation with a Join button.
        </p>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <input placeholder="Find a person by name…" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            style={{ flex: 1, padding: '.5rem .7rem', borderRadius: 8, border: '1px solid #d1d5db' }} />
          <button className="btn" disabled={!query.trim()} onClick={() => void search()}>Search</button>
        </div>
        {hits?.map((h) => (
          <div key={h.name} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
            <Avatar name={h.displayName ?? h.label} size={30} />
            <div style={{ flex: 1, minWidth: 0, fontSize: '.85rem' }}><b>{h.displayName ?? h.label}</b> <span style={{ opacity: 0.55 }}>{h.name}</span></div>
            <BusyButton busy={busy && busyFor === h.name} busyLabel="Signing & sending…" disabled={busy} onClick={() => void inviteAgent(h)}>Invite</BusyButton>
          </div>
        ))}
        {hits && hits.length === 0 && <p style={{ fontSize: '.78rem', opacity: 0.6 }}>No one found.</p>}
      </div>

      <div className="dash-section" style={{ maxWidth: 560, marginTop: '1.25rem' }}>
        <h2>Invite by email</h2>
        <p style={{ fontSize: '.85rem', opacity: 0.75, margin: '0 0 .6rem' }}>
          {dest.app
            ? 'This invitation is to that app, for this organization. They accept, then continue there signed in.'
            : 'Anyone with an email — they get a link and join this organization. Start from an app if you want them to land there.'}
        </p>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <input type="email" placeholder="name@example.org" value={email}
            onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void inviteEmail(); }}
            style={{ flex: 1, padding: '.5rem .7rem', borderRadius: 8, border: '1px solid #d1d5db' }} />
          <BusyButton busy={busy && !busyFor} busyLabel="Signing & sending…" disabled={busy || !email.trim()} onClick={() => void inviteEmail()}>Send invite</BusyButton>
        </div>
      </div>
    </div>
  );
}
