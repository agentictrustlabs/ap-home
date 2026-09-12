'use client';
// The reads Today (398 §4.2) and the attention model (§5.5) share: the runs parked on an agent, its schedule, the
// vocabulary its playbook offers, and its Library's artifacts. One hook, so the first page and the Messages filters
// never disagree about what is waiting.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRuns, listTriggers, homeVocabulary, listRunRecords, type ParkedRun, type TriggerRow, type AskVocabularyEntry, type RunRecordRow } from './ask';
import type { TodayArtifact } from './today';
import type { RunStateV1 } from './run-state';

export type ReadFailures = Partial<Record<'runs' | 'triggers' | 'vocabulary' | 'artifacts' | 'records', string>>;

export interface TodayReads {
  parked: Array<ParkedRun & { state?: RunStateV1 }> | null;
  /** Spec 398 §6.3 — a read that failed is SAID, never rendered as an empty list: which read, and why. */
  failed: ReadFailures;
  triggers: TriggerRow[];
  vocabulary: AskVocabularyEntry[];
  artifacts: TodayArtifact[];
  /** The agent's run records — each with its bill (396), for Today's cost line (§5.4). */
  records: RunRecordRow[];
  /** Drop a run the person just stopped — the runtime dropped its checkpoint. */
  dropRun: (runRef: string) => void;
}

export function useTodayReads(token: string | undefined, addressee: string | null, libraryScope: 'person' | 'other'): TodayReads {
  const [parked, setParked] = useState<TodayReads['parked']>(null);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [vocabulary, setVocabulary] = useState<AskVocabularyEntry[]>([]);
  const [artifacts, setArtifacts] = useState<TodayArtifact[]>([]);
  const [records, setRecords] = useState<RunRecordRow[]>([]);
  const [failed, setFailed] = useState<ReadFailures>({});
  useEffect(() => {
    if (!token || !addressee) return;
    let live = true;
    const why = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'unreachable';
    const fail = (k: keyof ReadFailures, e: unknown) => { if (live) setFailed((f) => ({ ...f, [k]: why(e) })); };
    setFailed({});
    void listRuns({ token }, addressee as Address).then((rs) => { if (live) setParked(rs as TodayReads['parked']); }).catch((e) => { fail('runs', e); if (live) setParked([]); });
    void listTriggers({ token }, addressee as Address).then((ts) => { if (live) setTriggers(ts); }).catch((e) => fail('triggers', e));
    void homeVocabulary(addressee).then((v) => { if (live) setVocabulary(v); }).catch((e) => fail('vocabulary', e));
    void listRunRecords({ token }, addressee as Address).then((r) => { if (live) setRecords(r.records); }).catch((e) => fail('records', e));
    const scopeQ = libraryScope === 'person' ? '' : `?org=${addressee}`;
    void fetch(`/connect/library${scopeQ}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error(`the Library answered ${r.status}`); return r.json(); })
      .then((b: { artifacts?: Array<{ id: string; name: string; kind?: string; folder?: string; createdAt?: number; version?: number; isFolder?: boolean }> }) => {
        if (!live) return;
        setArtifacts((b.artifacts ?? []).filter((a) => !a.isFolder && typeof a.createdAt === 'number').map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt as number, ...(a.kind ? { kind: a.kind } : {}), ...(a.folder ? { folder: a.folder } : {}), ...(a.version ? { version: a.version } : {}) })));
      })
      .catch((e) => fail('artifacts', e));
    return () => { live = false; };
  }, [token, addressee, libraryScope]);
  return { parked, triggers, vocabulary, artifacts, records, failed, dropRun: (runRef) => setParked((p) => (p ?? []).filter((r) => r.runRef !== runRef)) };
}
