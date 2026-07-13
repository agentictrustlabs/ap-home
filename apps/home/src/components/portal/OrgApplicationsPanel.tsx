'use client';
// Org enrollment — the steward's pending MembershipApplications queue (spec 324 §7/§12). Reads the org's
// `org.applications` vault doc (POST /connect/org-applications, steward-gated) and lets the steward APPROVE
// (sign the org→applicant member-access grant + POST /connect/org-decide → applicant gets a Join link and
// completes membership) or REJECT. Approval creates NO membership directly (ADR-0048): the member writes their
// own membership on join; the decision authorizes + invites it, and clears the application from the queue.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { signHashFor, resolveVia } from '../../home/onboarding';
import { issueOrganizationResourceAccessDelegation, toWire } from '../../lib/delegation';
import { MCP_SERVER_ID } from '../../lib/inbox-delivery';

interface AppItem { applicationId: string; applicant: string; message: string; submittedAt: string }

export function OrgApplicationsPanel({ org }: { org: string }) {
  const { session, profile } = useSession();
  const communityId = org.toLowerCase();
  const authed = { 'content-type': 'application/json', authorization: `Bearer ${session?.token ?? ''}` };

  const [items, setItems] = useState<AppItem[] | null>(null);
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const r = await fetch('/connect/org-applications', { method: 'POST', headers: authed, body: JSON.stringify({ org: communityId }) });
      const b = (await r.json().catch(() => ({}))) as { applications?: AppItem[]; error?: string };
      if (!r.ok) throw new Error(b.error ?? `read failed (${r.status})`);
      setItems(b.applications ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, communityId]);

  useEffect(() => { void load(); }, [load]);

  const decide = useCallback(async (it: AppItem, decision: 'approve' | 'reject') => {
    if (!session) return;
    setBusyFor(it.applicationId); setErr(null); setNote(null);
    try {
      let memberAccessDelegation: unknown;
      if (decision === 'approve') {
        // Sign the org→applicant member-access grant (custody stays with the steward's credential — route by
        // profile.credential, never raw session.via). Best-effort: a failed sign still records the decision.
        try {
          const via = resolveVia(profile?.credential, session.via);
          const sign = await signHashFor(via, communityId as Address, { token: session.token });
          memberAccessDelegation = toWire(await issueOrganizationResourceAccessDelegation(communityId as Address, it.applicant as Address, MCP_SERVER_ID, sign));
        } catch { /* proceed without a pre-signed grant */ }
      }
      const r = await fetch('/connect/org-decide', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ org: communityId, applicant: it.applicant, applicationId: it.applicationId, decision, ...(memberAccessDelegation ? { memberAccessDelegation } : {}) }),
      });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `decision failed (${r.status})`);
      setNote(decision === 'approve' ? 'Approved — the applicant was sent a Join link.' : 'Application declined.');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusyFor(null); }
  }, [session, profile?.credential, communityId, authed, load]);

  if (!items || items.length === 0) return null; // no pending applications → nothing to show

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 className="subhead" style={{ marginBottom: '.6rem' }}>Pending join requests · {items.length}</h3>
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '.82rem' }}>{err}</p>}
      {note && <p style={{ color: 'var(--color-sage-700, #047857)', fontSize: '.82rem' }}>{note}</p>}
      <div className="dash-section" style={{ maxWidth: 560 }}>
        {items.map((it) => (
          <div key={it.applicationId} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.6rem 0', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '.85rem' }}>
              <div style={{ fontFamily: 'monospace', fontSize: '.72rem', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.applicant}</div>
              {it.message && <div style={{ opacity: 0.85 }}>{it.message}</div>}
            </div>
            <BusyButton busy={busyFor === it.applicationId} busyLabel="Approving…" disabled={!!busyFor} onClick={() => void decide(it, 'approve')}>Approve</BusyButton>
            <button type="button" className="btn" disabled={!!busyFor} onClick={() => void decide(it, 'reject')}>Reject</button>
          </div>
        ))}
      </div>
    </div>
  );
}
