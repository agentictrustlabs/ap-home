'use client';
// The reads Today (398 §4.2) and the attention model (§5.5) share: the runs parked on an agent, its schedule, the
// vocabulary its playbook offers, and its Library's artifacts. One hook, so the first page and the Messages filters
// never disagree about what is waiting.
import { useEffect, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRuns, listTriggers, homeVocabulary, listRunRecords, type ParkedRun, type TriggerRow, type AskVocabularyEntry, type RunRecordRow } from './ask';
import type { TodayArtifact } from './today';
import type { RunStateV1 } from './run-state';
import type { DelegationWire } from '../lib/delegation';
import { vaultReadWithDelegation } from '../lib/vault-client';
import { readHeldAgentCatalog } from './held-agent-library';

/**
 * An agent the person HOLDS (a service, a persona): its Library is read from its own vault over the stewardship
 * delegation, the way its Records page reads it (see `held-agent-library.ts`). `loaded` false = the managed-agents
 * list is still out, so the artifacts read waits rather than answering "empty".
 */
export interface HeldLibrarySource { loaded: boolean; delegation: DelegationWire | null }

export type ReadFailures = Partial<Record<'runs' | 'triggers' | 'vocabulary' | 'artifacts' | 'records', string>>;

export interface TodayReads {
  parked: Array<ParkedRun & { state?: RunStateV1 }> | null;
  /** Spec 398 §6.3 — a read that failed is SAID, never rendered as an empty list: which read, and why. */
  failed: ReadFailures;
  /** Which reads are still out — the section shows a skeleton until its read answers. */
  pending: Record<'runs' | 'triggers' | 'vocabulary' | 'records' | 'artifacts', boolean>;
  triggers: TriggerRow[];
  vocabulary: AskVocabularyEntry[];
  artifacts: TodayArtifact[];
  /** The agent's run records — each with its bill (396), for Today's cost line (§5.4). */
  records: RunRecordRow[];
  /** Drop a run the person just stopped — the runtime dropped its checkpoint. */
  dropRun: (runRef: string) => void;
}

export function useTodayReads(token: string | undefined, addressee: string | null, libraryScope: 'person' | 'other', held?: HeldLibrarySource): TodayReads {
  const [parked, setParked] = useState<TodayReads['parked']>(null);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [vocabulary, setVocabulary] = useState<AskVocabularyEntry[]>([]);
  const [artifacts, setArtifacts] = useState<TodayArtifact[]>([]);
  const [records, setRecords] = useState<RunRecordRow[]>([]);
  const [failed, setFailed] = useState<ReadFailures>({});
  /** Which reads are still OUT — a section shows a skeleton, never an empty state, while its read is pending. */
  const [pending, setPending] = useState<Record<'runs' | 'triggers' | 'vocabulary' | 'records' | 'artifacts', boolean>>({ runs: true, triggers: true, vocabulary: true, records: true, artifacts: true });
  // A held agent's delegation rides a ref and its STATE keys the effect, so a re-render that rebuilds the same
  // delegation object does not re-run every read.
  const heldRef = useRef<HeldLibrarySource | undefined>(held);
  heldRef.current = held;
  const heldKey = !held ? 'none' : !held.loaded ? 'loading' : held.delegation ? `wire:${held.delegation.delegator}:${held.delegation.delegate}` : 'no-wire';
  useEffect(() => {
    if (!token || !addressee) return;
    let live = true;
    const why = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'unreachable';
    const fail = (k: keyof ReadFailures, e: unknown) => { if (live) setFailed((f) => ({ ...f, [k]: why(e) })); };
    setFailed({});
    setPending({ runs: true, triggers: true, vocabulary: true, records: true, artifacts: true });
    const done = (k: keyof typeof pending) => { if (live) setPending((p) => ({ ...p, [k]: false })); };
    void listRuns({ token }, addressee as Address).then((rs) => { if (live) setParked(rs as TodayReads['parked']); }).catch((e) => { fail('runs', e); if (live) setParked([]); }).finally(() => done('runs'));
    void listTriggers({ token }, addressee as Address).then((ts) => { if (live) setTriggers(ts); }).catch((e) => fail('triggers', e)).finally(() => done('triggers'));
    void homeVocabulary(addressee).then((v) => { if (live) setVocabulary(v); }).catch((e) => fail('vocabulary', e)).finally(() => done('vocabulary'));
    void listRunRecords({ token }, addressee as Address).then((r) => { if (live) setRecords(r.records); }).catch((e) => fail('records', e)).finally(() => done('records'));
    type LibraryRow = { id: string; name: string; kind?: string; folder?: string; createdAt?: number; version?: number; isFolder?: boolean };
    const toToday = (rows: LibraryRow[]): TodayArtifact[] =>
      rows.filter((a) => !a.isFolder && typeof a.createdAt === 'number').map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt as number, ...(a.kind ? { kind: a.kind } : {}), ...(a.folder ? { folder: a.folder } : {}), ...(a.version ? { version: a.version } : {}) }));
    const h = heldRef.current;
    if (h) {
      // A HELD agent: its own vault, over the stewardship delegation (the Records page's read).
      if (!h.loaded) return () => { live = false; }; // still resolving the delegation — the panel keeps its skeleton
      if (!h.delegation) { fail('artifacts', 'no stewardship delegation on this agent — Home cannot read its Library'); done('artifacts'); }
      else {
        void readHeldAgentCatalog(h.delegation, vaultReadWithDelegation)
          .then((rows) => { if (live) setArtifacts(toToday(rows)); })
          .catch((e) => fail('artifacts', e))
          .finally(() => done('artifacts'));
      }
      return () => { live = false; };
    }
    const scopeQ = libraryScope === 'person' ? '' : `?org=${addressee}`;
    void fetch(`/connect/library${scopeQ}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error(`the Library answered ${r.status}`); return r.json(); })
      .then((b: { artifacts?: LibraryRow[] }) => {
        if (!live) return;
        setArtifacts(toToday(b.artifacts ?? []));
      })
      .catch((e) => fail('artifacts', e))
      .finally(() => done('artifacts'));
    return () => { live = false; };
  }, [token, addressee, libraryScope, heldKey]);
  return { parked, triggers, vocabulary, artifacts, records, failed, pending, dropRun: (runRef) => setParked((p) => (p ?? []).filter((r) => r.runRef !== runRef)) };
}
