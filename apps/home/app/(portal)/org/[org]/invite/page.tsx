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

export default function OrgInvitePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  const { session } = useSession();
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

  const inviteAgent = useCallback(async (hit: AgentSearchHit) => {
    setBusy(true); setErr(null); setNote(null);
    try {
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
      setNote(`Invitation sent to ${hit.displayName ?? hit.name}.`);
      setQuery(''); setHits(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [authed, communityId]);

  const inviteEmail = useCallback(async () => {
    if (!email.trim()) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const res = await fetch('/connect/org-invite/email', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ org: communityId, email: email.trim().toLowerCase() }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; delivery?: string; error?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `invite failed (${res.status})`);
      setNote(b.delivery === 'logged'
        ? `Email sending isn't configured yet — the invite link was logged server-side (dev).`
        : `Invitation emailed to ${email.trim()}.`);
      setEmail('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [authed, communityId, email]);

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
            <button className="btn" disabled={busy} onClick={() => void inviteAgent(h)}>Invite</button>
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
          <button className="btn" disabled={busy || !email.trim()} onClick={() => void inviteEmail()}>Send invite</button>
        </div>
      </div>
    </SectionShell>
  );
}
