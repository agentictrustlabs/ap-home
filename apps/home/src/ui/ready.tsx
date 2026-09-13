'use client';
// READINESS (design system v2, 2026-09-13). A page is a set of reads; a person must be able to tell, at a glance,
// whether what they see is the answer or the wait. So: every `Panel` says which state it is in — loading (a skeleton
// the shape of what is coming), ready, empty (a fact, said only AFTER the read answered), or unknown (the read failed,
// named) — and the page head keeps count: a thin progress line under the topbar while any panel is loading, and an
// "updated" line once every read is in. No panel renders an empty state before its read has returned.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface ReadyCtx { begin(id: string): void; end(id: string): void; busy: number; settledAt: number | null }
const Ctx = createContext<ReadyCtx | null>(null);

export function ReadyProvider({ children }: { children: ReactNode }) {
  const [busySet, setBusySet] = useState<Set<string>>(() => new Set());
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const everBusy = useRef(false);
  const value = useMemo<ReadyCtx>(() => ({
    busy: busySet.size,
    settledAt,
    begin: (id) => { everBusy.current = true; setBusySet((s) => { if (s.has(id)) return s; const n = new Set(s); n.add(id); return n; }); },
    end: (id) => setBusySet((s) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; }),
  }), [busySet, settledAt]);
  useEffect(() => { if (busySet.size === 0 && everBusy.current) setSettledAt(Date.now()); }, [busySet]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Report one read's state to the page. `loading` true → the page is busy until it turns false. */
export function useReadyReport(id: string, loading: boolean): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    if (loading) ctx.begin(id); else ctx.end(id);
    return () => ctx.end(id);
  }, [ctx, id, loading]);
}

export function usePageReady(): { busy: boolean; settledAt: number | null } {
  const ctx = useContext(Ctx);
  return { busy: (ctx?.busy ?? 0) > 0, settledAt: ctx?.settledAt ?? null };
}
