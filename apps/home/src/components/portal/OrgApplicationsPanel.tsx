'use client';
// Org enrollment — the steward's pending MembershipApplications queue (spec 324 §7/§12). Reads the ORG's inbox
// filtered to kind:'membership-application' (GET /connect/inbox?agent&contextKind — no bespoke index) and lets
// the steward APPROVE (sign the org→applicant member-access grant + POST /connect/org-decide → applicant gets a
// Join link and completes membership) or REJECT. Approval creates NO membership directly (ADR-0048): the member
// writes their own membership on join; the decision authorizes + invites it.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { ContextRefV1 } from '@agenticprimitives/fabric/messaging';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { signHashFor, resolveVia } from '../../home/onboarding';
import { issueOrganizationResourceAccessDelegation, toWire } from '../../lib/delegation';
import { MCP_SERVER_ID } from '../../lib/inbox-delivery';

interface AppItem { messageId: string; contextRefs: ContextRefV1[]; bodyPreview?: string; lastEventAt: string }

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
      const r = await fetch(`/connect/inbox?agent=${communityId}&contextKind=membership-application`, { headers: authed });
      const b = (await r.json().catch(() => ({}))) as { items?: AppItem[]; error?: string };
      if (!r.ok) throw new Error(b.error ?? `read failed (${r.status})`);
      setItems(b.items ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, communityId]);

  useEffect(() => { void load(); }, [load]);

  const applicantOf = (it: AppItem): string | undefined => it.contextRefs.find((r) => r.kind === 'applicant')?.id;

  const archive = useCallback(async (messageId: string) => {
    await fetch('/connect/inbox', { method: 'POST', headers: authed, body: JSON.stringify({ action: 'archive', agent: communityId, messageId }) }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId]);

  const decide = useCallback(async (it: AppItem, decision: 'approve' | 'reject') => {
    if (!session) return;
    const applicant = applicantOf(it);
    if (!applicant) { setErr('application is missing the applicant reference'); return; }
    setBusyFor(it.messageId); setErr(null); setNote(null);
    try {
      let memberAccessDelegation: unknown;
      if (decision === 'approve') {
        // Sign the org→applicant member-access grant (custody stays with the steward's credential — route by
        // profile.credential, never raw session.via). Best-effort: a failed sign still records the decision.
        try {
          const via = resolveVia(profile?.credential, session.via);
          const sign = await signHashFor(via, communityId as Address, { token: session.token });
          memberAccessDelegation = toWire(await issueOrganizationResourceAccessDelegation(communityId as Address, applicant as Address, MCP_SERVER_ID, sign));
        } catch { /* proceed without a pre-signed grant */ }
      }
      const r = await fetch('/connect/org-decide', {
        method: 'POST', headers: authed,
        body: JSON.stringify({ org: communityId, applicant, applicationId: it.messageId, decision, ...(memberAccessDelegation ? { memberAccessDelegation } : {}) }),
      });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !b.ok) throw new Error(b.error ?? `decision failed (${r.status})`);
      await archive(it.messageId);
      setNote(decision === 'approve' ? 'Approved — the applicant was sent a Join link.' : 'Application declined.');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusyFor(null); }
  }, [session, profile?.credential, communityId, authed, archive, load]);

  if (!items || items.length === 0) return null; // no pending applications → nothing to show

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 className="subhead" style={{ marginBottom: '.6rem' }}>Pending join requests · {items.length}</h3>
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '.82rem' }}>{err}</p>}
      {note && <p style={{ color: 'var(--color-sage-700, #047857)', fontSize: '.82rem' }}>{note}</p>}
      <div className="dash-section" style={{ maxWidth: 560 }}>
        {items.map((it) => (
          <div key={it.messageId} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.6rem 0', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: '.85rem' }}>
              <div style={{ fontFamily: 'monospace', fontSize: '.72rem', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis' }}>{applicantOf(it) ?? 'unknown applicant'}</div>
              {it.bodyPreview && <div style={{ opacity: 0.85 }}>{it.bodyPreview}</div>}
            </div>
            <BusyButton busy={busyFor === it.messageId} busyLabel="Approving…" disabled={!!busyFor} onClick={() => void decide(it, 'approve')}>Approve</BusyButton>
            <button type="button" className="btn" disabled={!!busyFor} onClick={() => void decide(it, 'reject')}>Reject</button>
          </div>
        ))}
      </div>
    </div>
  );
}
