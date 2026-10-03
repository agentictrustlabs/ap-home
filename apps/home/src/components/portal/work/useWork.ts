'use client';
// Shared data hooks for the coordination Work surfaces (spec 334 §6/§7).
// Same fetch/gating conventions as OrgDiscussionsView: bearer session to the
// /connect proxy, 403 ⇒ non-member, slow poll to keep RPC headroom.
import { useCallback, useEffect, useState, useRef } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession, type Session } from '../../../context/session';
import { activateInteractionsIfNeeded, resolveVia } from '../../../home/onboarding';
import { ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS } from '../../../lib/delegation';
import {
  fetchWorkList,
  projectAllocationEntry,
  projectCommitmentEntry,
  projectDecisionCard,
  type AllocationRow,
  type EndeavorRequestRow,
  type EndeavorRow,
  type WorkListResponse,
} from '../../../lib/work-client';
import type { HomeContributionEntryV1, HomeDecisionCardV1 } from '@agenticprimitives/home';
import { validateHomeContributionEntry, validateHomeDecisionCard } from '@agenticprimitives/home';
import { membersFromReceivedDelegations } from '../../../lib/recipient-directory';
import { isHiddenOrg } from '../../../lib/org-lifecycle';

export interface RelatedOrg {
  orgAgent: string;
  orgName?: string;
  relationship: 'steward' | 'member';
}

/** Run `fn` over `items` with at most `limit` in flight at once (perf, 2026-10-03). A person in many orgs
 *  must not fan out one vault-backed read per org simultaneously — that burst is what tripped the throttle. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  });
  await Promise.all(workers);
  return out;
}

/** Orgs this person belongs to (steward or member) + whether the lookup has settled — the Home
 *  Request target options + the My Work aggregation set. `loaded` lets callers hold a spinner until
 *  the org set is known (so an empty result isn't flashed before the fetch returns). */
export function useRelatedOrgsState(session: Session | null): { orgs: RelatedOrg[]; loaded: boolean } {
  const [orgs, setOrgs] = useState<RelatedOrg[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!session) { setLoaded(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/connect/related-orgs', { headers: { authorization: `Bearer ${session.token}` } });
        const b = (await res.json().catch(() => ({}))) as { orgs?: Array<{ orgAgent?: string; orgName?: string; relationship?: string; kind?: string; status?: string }> };
        if (cancelled) return;
        setOrgs(
          (b.orgs ?? [])
            // spec 342 — a working surface: no deactivated or deleted org in a request-target picker.
            .filter((o) => o.orgAgent && (o.kind ?? 'org') === 'org' && !isHiddenOrg(o))
            .map((o) => ({
              orgAgent: (o.orgAgent ?? '').toLowerCase(),
              ...(o.orgName ? { orgName: o.orgName } : {}),
              relationship: o.relationship === 'member' ? 'member' as const : 'steward' as const,
            })),
        );
      } catch { /* picker stays empty */ }
      finally { if (!cancelled) setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [session?.token]);
  return { orgs, loaded };
}

/** Orgs this person belongs to (steward or member) — the Home Request target
 *  options + the My Work aggregation set. */
export function useRelatedOrgs(session: Session | null): RelatedOrg[] {
  return useRelatedOrgsState(session).orgs;
}

/** Directory displayName per member SA (lowercased address → name) — the same roster read
 *  Discussions uses, so Work surfaces render agent names, never bare addresses. */
export function useOrgMemberNames(session: Session | null, org: string): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!session || !org) return;
    let cancelled = false;
    void (async () => {
      try {
        // BOTH projections of membership, as everywhere else: a directory listing is the member's own
        // signed row, and the received-delegations index holds those who joined by invite and never
        // published one. Reading only the directory left invited members labelled by raw address on work
        // they are assigned — the same half-read that made them invisible in Discussions.
        const headers = { authorization: `Bearer ${session.token}` };
        const [dirRes, recRes] = await Promise.all([
          fetch(`/connect/directory?communityId=${org.toLowerCase()}`, { headers }),
          fetch('/connect/received-delegations', { headers }),
        ]);
        const b = (await dirRes.json().catch(() => ({}))) as { listings?: Array<{ listing?: { subject?: string; displayName?: string } }> };
        if (cancelled) return;
        const map: Record<string, string> = {};
        // Invited members first; a listing is the member's OWN row, so it wins on the label.
        if (recRes.ok) {
          const rec = (await recRes.json().catch(() => ({}))) as Parameters<typeof membersFromReceivedDelegations>[0];
          for (const m of membersFromReceivedDelegations(rec, org)) map[m.address] = m.displayName;
        }
        for (const row of b.listings ?? []) {
          const addr = row.listing?.subject?.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
          if (addr && row.listing?.displayName) map[addr] = row.listing.displayName;
        }
        if (!cancelled) setNames(map);
      } catch { /* names stay short-address */ }
    })();
    return () => { cancelled = true; };
  }, [session?.token, org]);
  return names;
}

export interface WorkListState {
  data: WorkListResponse | null;
  member: boolean | null;
  steward: boolean;
  error: string | null;
  /** The org's interactions grant predates the coordination scopes — a steward must re-enable. */
  needsReEnable: boolean;
  refresh: () => Promise<void>;
}

/** FORCE re-issue of a principal's interactions grant (the Enable ceremony's mint) so it carries the
 *  CURRENT scope list — the fix for a grant signed before the vault:coordination.* wave. Force is
 *  required: /status reports the grant as current (the coordination scopes are additive, not in
 *  REQUIRED_SCOPES), so the non-forced path would skip. Steward-gated server-side by the grant op. */
export function useReEnableInteractions(): (principal: Address) => Promise<{ ok: boolean; error?: string }> {
  const { session, profile } = useSession();
  return useCallback(async (principal: Address) => {
    if (!session) return { ok: false, error: 'not signed in' };
    const via = resolveVia(profile?.credential, session.via);
    // Token always passed: KMS and demo-account homes both sign server-side with it; the wallet
    // and passkey paths ignore it.
    const auth = { token: session.token };
    // Org re-enable: the steward signs ONCE here and will not return to re-sign, so the leaf is long-lived
    // (org-leaf-decay, 2026-10-03). A person's own leaf stays short (self-healed on login) and never uses this path.
    const r = await activateInteractionsIfNeeded(principal, via, auth, true, ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'could not re-enable storage' };
  }, [session, profile]);
}

/** The org's endeavor.list projection (spec 334 §3) — polled like discussions. */
export function useWorkList(session: Session | null, org: string): WorkListState {
  const [data, setData] = useState<WorkListResponse | null>(null);
  const [member, setMember] = useState<boolean | null>(null);
  const [steward, setSteward] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReEnable, setNeedsReEnable] = useState(false);

  const refreshing = useRef(false);
  // STOP THE STORM (spec 423 §3.2 / L1). A stale org (`needsReEnable`) or one this viewer is not a member of will
  // answer the SAME 409 on every tick until a STEWARD re-enables it — nothing the 12s poll does can change that, so
  // it only re-storms the console and the vault budget. Once we see that terminal state we PAUSE the interval; a
  // steward's explicit re-enable calls `refresh()` directly (below), which bypasses the pause and resumes a live org.
  const pausedRef = useRef(false);
  // Read the session through a ref so `refresh` does NOT change identity when the session object/token churns
  // between renders — that churn re-fired the `[refresh]` effect every render (the single-org twin of the My Work
  // loop) and re-created the 12s poll each time. Keyed on `org` only; the latest session is read at call time.
  const sessRef = useRef(session); sessRef.current = session;
  const refresh = useCallback(async () => {
    const session = sessRef.current;
    if (!session || !org || refreshing.current) return;
    refreshing.current = true;
    try {
      const r = await fetchWorkList(session.token, org);
      if (r.member === false) { setMember(false); setData(null); setError(null); pausedRef.current = true; return; }
      setSteward(r.steward === true);
      if (r.ok === false && r.error) { setError(r.error); setNeedsReEnable(r.needsReEnable === true); pausedRef.current = r.needsReEnable === true; return; }
      setMember(true);
      setData(r);
      setError(null);
      setNeedsReEnable(false);
      pausedRef.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { refreshing.current = false; }
  }, [org]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    // Skip a tick while paused (stale / not-a-member) instead of tearing the interval down, so it resumes
    // on its own the moment a live read lands (e.g. after a steward re-enable clears `pausedRef`).
    const t = setInterval(() => { if (pausedRef.current) return; void refresh(); }, 12000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, member, steward, error, needsReEnable, refresh };
}

// ── MY WORK, across every organization I belong to — the one aggregation My Work and Today both read ──────
export interface OrgWorkBundle {
  org: string;
  orgName?: string;
  allocations: AllocationRow[];
  entries: HomeContributionEntryV1[];
  decisions: HomeDecisionCardV1[];
  /** Requests THIS viewer submitted to the org (§12 — the requester sees their own). */
  myRequests: EndeavorRequestRow[];
  /** The org's visible endeavors — used to resolve adopted requests to their endeavor. */
  endeavors: EndeavorRow[];
}

/** An org whose interactions grant predates the vault:coordination.* scopes (the serving
 *  plane's 409 needsReEnable signal) — a steward re-signs via the re-enable ceremony. */
export interface StaleOrg {
  org: string;
  orgName?: string;
  steward: boolean;
}

/** Every organization's work as it concerns THIS person: their allocations and active commitments, the decisions
 *  waiting on them (393), the requests they submitted, the org's endeavors. `bundles === null` until the first read;
 *  a stale org (grant predates the coordination scopes) is reported, never silently dropped. */
export function useMyWork(session: Session | null, agentAddress: string | null | undefined): {
  bundles: OrgWorkBundle[] | null; staleOrgs: StaleOrg[]; error: string | null; load: () => Promise<void>; orgsLoaded: boolean;
} {
  const { orgs, loaded: orgsLoaded } = useRelatedOrgsState(session);
  const [bundles, setBundles] = useState<OrgWorkBundle[] | null>(null);
  const [staleOrgs, setStaleOrgs] = useState<StaleOrg[]>([]);
  const [error, setError] = useState<string | null>(null);
  // GUARD (perf, 2026-10-03): an unstable `load` identity made the `[load]` effect re-fire every render, and
  // each firing fanned out ONE /connect/work read PER ORG — a storm that saturated the vault budget and
  // surfaced as repeated 409s on almost every page. Never run two loads at once; never re-enter.
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (!session || !agentAddress || !orgsLoaded) return;
    if (inFlight.current) return;
    inFlight.current = true;
    const stale: StaleOrg[] = [];
    try {
      // Bounded concurrency: at most 3 org reads in flight, so a person in many orgs does not spike the
      // per-minute vault budget in one burst.
      const results = await mapLimit(orgs, 3, async (o): Promise<OrgWorkBundle | null> => {
        try {
          const r = await fetchWorkList(session.token, o.orgAgent);
          if (r.needsReEnable === true) {
            stale.push({ org: o.orgAgent, ...(o.orgName ? { orgName: o.orgName } : {}), steward: r.steward === true || o.relationship === 'steward' });
            return null;
          }
          if (r.member === false || r.ok === false) return null;
          const allocations = r.mine?.allocations ?? [];
          const entries = [
            ...allocations.map((a) => projectAllocationEntry(o.orgAgent, agentAddress, a)),
            ...(r.mine?.commitments ?? [])
              .filter((c) => c.status === 'active')
              .map((c) => projectCommitmentEntry(o.orgAgent, agentAddress, c)),
            // Allocations may precede plan adoption (no planRef yet) — render them anyway;
            // committed entries must pass the portable contract's fail-closed validation.
          ].filter((e) => e.status === 'allocated' || validateHomeContributionEntry(e).length === 0);
          const decisions = (r.mine?.decisions ?? [])
            .filter((d) => d.status === 'pending')
            .map((d) => projectDecisionCard(o.orgAgent, d))
            .filter((c) => validateHomeDecisionCard(c).length === 0);
          const myRequests = (r.requests ?? []).filter((q) => q.requester.toLowerCase() === agentAddress.toLowerCase());
          return { org: o.orgAgent, ...(o.orgName ? { orgName: o.orgName } : {}), allocations, entries, decisions, myRequests, endeavors: r.endeavors ?? [] };
        } catch { return null; }
      });
      setBundles(results.filter((b): b is OrgWorkBundle => b !== null));
      setStaleOrgs(stale);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { inFlight.current = false; }
  }, [session, agentAddress, orgs, orgsLoaded]);
  // Re-run ONLY when the ORG SET or its loaded-flag changes — the two things that decide what to fetch. Keying on
  // `session?.token` or `agentAddress` was the loop: in the live app those identities churn between renders (a token
  // refresh, a new session object), the effect re-fired every render, and each firing fanned out one vault-backed
  // read per org (incognito reproduced it; a fixed injected token hid it). `load` reads the latest session/address
  // through `loadRef`; it needs no re-fire of its own, because a real account/acting-as change also changes the org
  // set, so `orgsKey` already captures it.
  const loadRef = useRef(load); loadRef.current = load;
  const orgsKey = orgs.map((o) => o.orgAgent).join(',');
  useEffect(() => { void loadRef.current(); }, [orgsKey, orgsLoaded]);
  return { bundles, staleOrgs, error, load, orgsLoaded };
}
