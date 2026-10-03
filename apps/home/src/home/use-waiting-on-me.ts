'use client';
// The bell's data (B6a): parked runs of the person's own agent, their work across organizations, and the invitations that
// reached them — read through the same capability the conversation answers "what invitations do I have" with
// (`person.invitations.list`, a supplied plan at /harness/ask). Cheap reads every minute; the per-organization work list on
// mount, on focus and every few minutes (it is one fetch per organization).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRuns, type ParkedRun } from './ask';
import { useMyWork } from '../components/portal/work/useWork';
import { assembleWaiting, type ReceivedInvitation, type WaitingItem } from './waiting-on-me';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import type { Session } from '../context/session';

const FAST_MS = 60_000;
const SLOW_MS = 180_000;

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
    const now = Date.now();
    const invFresh = invCache.current !== null && (now - invCache.current.at) < FAST_MS;
    const [runs, invs] = await Promise.all([
      listRuns({ token }, me as Address).catch(() => null),
      invFresh ? Promise.resolve(invCache.current!.value) : readInvitations(token, me),
    ]);
    if (runs) setParked(runs);
    if (invs) { setInvitations(invs); if (!invFresh) invCache.current = { at: now, value: invs }; }
  }, [token, me]);

  useEffect(() => {
    if (!token || !me) return;
    void readFast();
    const fast = setInterval(() => void readFast(), FAST_MS);
    const slow = setInterval(() => void loadWork(), SLOW_MS);
    const onFocus = () => { void readFast(); void loadWork(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(fast); clearInterval(slow); window.removeEventListener('focus', onFocus); };
  }, [token, me, readFast, loadWork]);

  const items = useMemo(() => (parked === null ? null : assembleWaiting({ now: Date.now(), parked: parked as never, bundles: bundles ?? [], invitations })), [parked, bundles, invitations]);
  return { items, refresh: () => { void readFast(); void loadWork(); } };
}
