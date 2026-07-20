'use client';
// Shared data hooks for the coordination Work surfaces (spec 334 §6/§7).
// Same fetch/gating conventions as OrgDiscussionsView: bearer session to the
// /connect proxy, 403 ⇒ non-member, slow poll to keep RPC headroom.
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../../../context/session';
import { fetchWorkList, type WorkListResponse } from '../../../lib/work-client';

export interface RelatedOrg {
  orgAgent: string;
  orgName?: string;
  relationship: 'steward' | 'member';
}

/** Orgs this person belongs to (steward or member) — the Home Request target
 *  options + the My Work aggregation set. */
export function useRelatedOrgs(session: Session | null): RelatedOrg[] {
  const [orgs, setOrgs] = useState<RelatedOrg[]>([]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` } });
        const b = (await res.json().catch(() => ({}))) as { orgs?: Array<{ orgAgent?: string; orgName?: string; relationship?: string; kind?: string }> };
        if (cancelled) return;
        setOrgs(
          (b.orgs ?? [])
            .filter((o) => o.orgAgent && (o.kind ?? 'org') === 'org')
            .map((o) => ({
              orgAgent: (o.orgAgent ?? '').toLowerCase(),
              ...(o.orgName ? { orgName: o.orgName } : {}),
              relationship: o.relationship === 'member' ? 'member' as const : 'steward' as const,
            })),
        );
      } catch { /* picker stays empty */ }
    })();
    return () => { cancelled = true; };
  }, [session]);
  return orgs;
}

export interface WorkListState {
  data: WorkListResponse | null;
  member: boolean | null;
  steward: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** The org's endeavor.list projection (spec 334 §3) — polled like discussions. */
export function useWorkList(session: Session | null, org: string): WorkListState {
  const [data, setData] = useState<WorkListResponse | null>(null);
  const [member, setMember] = useState<boolean | null>(null);
  const [steward, setSteward] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session || !org) return;
    try {
      const r = await fetchWorkList(session.token, org);
      if (r.member === false) { setMember(false); setData(null); setError(null); return; }
      if (r.ok === false && r.error) { setError(r.error); return; }
      setMember(true);
      setSteward(r.steward === true);
      setData(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session, org]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const t = setInterval(() => void refresh(), 12000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, member, steward, error, refresh };
}
