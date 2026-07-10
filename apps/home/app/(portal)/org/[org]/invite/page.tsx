'use client';
// Org → Invite member (spec 315). ONE invitation, TWO delivery paths:
//   • Existing named agent (KB search) → in-app: an inbox message + a "Join" chip (reuses the spec-318
//     channel-invite pattern; no email needed).
//   • Anyone by email → an invite link (/invite/<token>) sent via SendGrid; they confirm email + join.
// Both end in the invitee publishing their own self-signed listing (ADR-0025 — the invite never enrolls).
import { use, useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../../../src/context/session';
import { SectionShell } from '../../../../../src/components/portal/SectionShell';
import { searchAgentsKb, type AgentSearchHit } from '../../../../../src/lib/agent-search';
import { Avatar } from '../../../../../src/components/portal/chat/Avatar';
import { BusyButton } from '../../../../../src/components/shared/BusyButton';
import { signHashFor, resolveVia } from '../../../../../src/home/onboarding';
import { issueMemberAccessDelegation, toWire, type DelegationWire } from '../../../../../src/lib/delegation';
import { MCP_SERVER_ID } from '../../../../../src/lib/inbox-delivery';

export default function OrgInvitePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session, profile } = useSession();
  const communityId = org.toLowerCase();
  const authed = { 'content-type': 'application/json', authorization: `Bearer ${session?.token ?? ''}` };

  // In-app (existing agent)
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AgentSearchHit[] | null>(null);
  // Email
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setHits(await searchAgentsKb(query.trim()).catch(() => []));
  }, [query]);

  const [busyFor, setBusyFor] = useState<string | null>(null);
  const inviteAgent = useCallback(async (hit: AgentSearchHit) => {
    if (!session) return;
    setBusy(true); setBusyFor(hit.name); setErr(null); setNote(null);
    let grantNote = '';
    try {
      // spec 321 W2b — the invitee's SA is KNOWN: pre-sign the org→invitee member-access grant and
      // store it in the org vault; /connect/org-membership picks it up when they join. Best-effort —
      // a failed sign/store still sends a valid (grant-less) invitation.
      try {
        const via = resolveVia(profile?.credential, session.via);
        const sign = await signHashFor(via, communityId as Address, { token: session.token });
        const mad = toWire(await issueMemberAccessDelegation(communityId as Address, hit.smartAgent as Address, MCP_SERVER_ID, sign));
        const gr = await fetch('/connect/org-invite/agent', {
          method: 'POST', headers: authed,
          body: JSON.stringify({ org: communityId, agent: hit.smartAgent.toLowerCase(), memberAccessDelegation: mad }),
        });
        const gb = (await gr.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!gr.ok || !gb.ok) throw new Error(gb.error ?? `grant store failed (${gr.status})`);
      } catch (e) {
        grantNote = ` (without a pre-signed access grant: ${e instanceof Error ? e.message : String(e)})`;
      }
      const res = await fetch('/connect/inbox', {
        method: 'POST', headers: authed,
        body: JSON.stringify({
          action: 'send', toName: hit.name,
          bodyText: `You're invited to join this organization. Open the "Join" chip on this message to accept — you'll sign a listing you can revoke anytime.`,
          contextRefs: [{ kind: 'org-channels', id: communityId, label: 'Join the organization' }],
        }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || b.ok === false) throw new Error(b.error ?? `invite failed (${res.status})`);
      setNote(`Invitation sent to ${hit.displayName ?? hit.name}.` + grantNote);
      setQuery(''); setHits(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setBusyFor(null); }
  }, [authed, communityId, profile?.credential, session]);

  const inviteEmail = useCallback(async () => {
    if (!email.trim() || !session) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const addr = email.trim().toLowerCase();
      // spec 321 W2 — pre-sign the org→invitee member-access grant against the invitee's
      // COUNTERFACTUAL home address (the email-bootstrap derivation redeem will repeat). The ORG is
      // the delegator, so the signer is the steward's credential that custodies the org (sign-by-
      // credential); best-effort — a failed predict/sign still sends a valid (grant-less) invite.
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
        memberAccessDelegation = toWire(await issueMemberAccessDelegation(communityId as Address, pb.agent, MCP_SERVER_ID, sign));
      } catch (e) {
        grantNote = ` (without a pre-signed access grant: ${e instanceof Error ? e.message : String(e)})`;
      }
      const res = await fetch('/connect/org-invite/email', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ org: communityId, email: addr, ...(memberAccessDelegation ? { memberAccessDelegation } : {}) }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `invite failed (${res.status})`);
      setNote((b.delivery === 'logged'
        ? `Email sending isn't configured yet — the invite link was logged server-side (dev).`
        : `Invitation emailed to ${email.trim()}.`) + grantNote);
      setEmail('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [authed, communityId, email, profile?.credential, session?.via, session?.token]);

  return (
    <SectionShell title="Invite a member">
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
          Anyone with an email — they get a link, confirm their email, and join.
        </p>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <input type="email" placeholder="name@example.org" value={email}
            onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void inviteEmail(); }}
            style={{ flex: 1, padding: '.5rem .7rem', borderRadius: 8, border: '1px solid #d1d5db' }} />
          <BusyButton busy={busy && !busyFor} busyLabel="Signing & sending…" disabled={busy || !email.trim()} onClick={() => void inviteEmail()}>Send invite</BusyButton>
        </div>
      </div>
    </SectionShell>
  );
}
