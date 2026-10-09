'use client';
// The bell's data (B6a): parked runs of the person's own agent, their work across organizations, and the invitations that
// reached them — read through the same capability the conversation answers "what invitations do I have" with
// (`person.invitations.list`, a supplied plan at /harness/ask). Cheap reads every minute; the per-organization work list on
// mount, on focus and every few minutes (it is one fetch per organization).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { fetchParkedRuns, type ParkedRun } from './ask';
import { useMyWork } from '../components/portal/work/useWork';
import { assembleWaiting, type ReceivedInvitation, type WaitingItem } from './waiting-on-me';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import type { Session } from '../context/session';

const FAST_MS = 60_000;
const SLOW_MS = 180_000;

// ONE POLLER ACROSS TABS, NONE IN A HIDDEN ONE (2026-10-04). Measured on a persona: 1,488 background reads in 33 hours,
// 320 within 2 s of the one before — several open tabs each polling, hidden ones included. The read's result is shared
// through localStorage (`at` + `value`); a tab about to read first CLAIMS it (`claimAt`), so a second tab waits for that
// result instead of reading again. Storage that throws (private mode, blocked) leaves each tab reading for itself.
const CLAIM_MS = 15_000;
const sharedKey = (me: string): string => `ap:bell:invitations:${me}`;
type SharedInvitations = { at?: number; value?: ReceivedInvitation[]; claimAt?: number };
function readShared(me: string): SharedInvitations | null {
  try { const raw = localStorage.getItem(sharedKey(me)); return raw ? (JSON.parse(raw) as SharedInvitations) : null; } catch { return null; }
}
function writeShared(me: string, v: SharedInvitations): void {
  try { localStorage.setItem(sharedKey(me), JSON.stringify(v)); } catch { /* no shared storage: this tab reads for itself */ }
}
const tabHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

async function readInvitations(token: string, person: string): Promise<ReceivedInvitation[] | null> {
  await ensureCsrfToken();
  const r = await fetch('/a2a/harness/ask', {
    method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...csrfHeaders() },
    // Spec 423 L1 — `background: true`: this is the app polling, not the person asking. Still traced + LLM-free
    // (supplied plan + rowsOnly), but its run is marked so it stays out of the human "What this agent did" list.
    body: JSON.stringify({ session: token, addressee: person.toLowerCase(), message: 'what invitations do i have', background: true, rowsOnly: true, plan: { steps: [{ toolId: 'person.invitations.list', args: {} }] } }),
  }).catch(() => null);
  const out = r ? ((await r.json().catch(() => ({}))) as { reply?: { kind?: string; results?: Array<{ toolId: string; result: unknown }> } }) : {};
  if (out.reply?.kind !== 'answer') return null;
  const found = out.reply.results?.find((x) => x.toolId === 'person.invitations.list')?.result as { invitations?: ReceivedInvitation[] } | undefined;
  return found?.invitations ?? [];
}

export function useWaitingOnMe(session: Session | null, agentAddress: string | null | undefined): { items: WaitingItem[] | null; refresh: () => void } {
  const { bundles, load: loadWork } = useMyWork(session, agentAddress);
  const [parked, setParked] = useState<ParkedRun[] | null>(null);
  const [invitations, setInvitations] = useState<ReceivedInvitation[]>([]);
  const token = session?.token ?? null;
  const me = agentAddress ? agentAddress.toLowerCase() : null;

  // Spec 423 L1 — FLOOR the invitations read to once per FAST_MS. `readFast` fires on mount, on every window focus,
  // AND on the 60s poll; without a floor, every page refresh / tab switch minted another (traced) background read.
  // The cache lets focus and remounts reuse the last value; only the poll (>= FAST_MS) actually re-reads.
  const invCache = useRef<{ at: number; value: ReceivedInvitation[] } | null>(null);
  const readFast = useCallback(async () => {
    if (!token || !me) return;
    if (tabHidden()) return; // a hidden tab reads nothing; it catches up when it is shown (visibilitychange below)
    const now = Date.now();
    const shared = readShared(me);
    if (shared?.value && typeof shared.at === 'number' && (now - shared.at) < FAST_MS) invCache.current = { at: shared.at, value: shared.value };
    const invFresh = invCache.current !== null && (now - invCache.current.at) < FAST_MS;
    // Another tab claimed the read moments ago: its result arrives by the storage event, not by a second read.
    const claimedElsewhere = !invFresh && typeof shared?.claimAt === 'number' && (now - shared.claimAt) < CLAIM_MS;
    if (!invFresh && !claimedElsewhere) writeShared(me, { ...(shared ?? {}), claimAt: now });
    const [runs, invs] = await Promise.all([
      fetchParkedRuns({ token }, me as Address).catch(() => null),
      invFresh ? Promise.resolve(invCache.current!.value) : claimedElsewhere ? Promise.resolve(null) : readInvitations(token, me),
    ]);
    if (runs) setParked(runs);
    if (invs) {
      setInvitations(invs);
      if (!invFresh && !claimedElsewhere) { invCache.current = { at: now, value: invs }; writeShared(me, { at: now, value: invs }); }
    }
  }, [token, me]);

  useEffect(() => {
    if (!token || !me) return;
    void readFast();
    const fast = setInterval(() => void readFast(), FAST_MS);
    const slow = setInterval(() => { if (!tabHidden()) void loadWork(); }, SLOW_MS);
    const onFocus = () => { void readFast(); void loadWork(); };
    const onVisible = () => { if (!tabHidden()) onFocus(); };
    // Another tab's read lands here: the bell updates without this tab asking.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== sharedKey(me) || !e.newValue) return;
      try { const v = JSON.parse(e.newValue) as SharedInvitations; if (v.value && typeof v.at === 'number') { invCache.current = { at: v.at, value: v.value }; setInvitations(v.value); } } catch { /* ignore */ }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => { clearInterval(fast); clearInterval(slow); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('storage', onStorage); };
  }, [token, me, readFast, loadWork]);

  const items = useMemo(() => (parked === null ? null : assembleWaiting({ now: Date.now(), parked: parked as never, bundles: bundles ?? [], invitations })), [parked, bundles, invitations]);
  return { items, refresh: () => { void readFast(); void loadWork(); } };
}
