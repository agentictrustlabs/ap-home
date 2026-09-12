'use client';
// The reads Today (398 §4.2) and the attention model (§5.5) share: the runs parked on an agent, its schedule, the
// vocabulary its playbook offers, and its Library's artifacts. One hook, so the first page and the Messages filters
// never disagree about what is waiting.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRuns, listTriggers, homeVocabulary, type ParkedRun, type TriggerRow, type AskVocabularyEntry } from './ask';
import type { TodayArtifact } from './today';
import type { RunStateV1 } from './run-state';

export interface TodayReads {
  parked: Array<ParkedRun & { state?: RunStateV1 }> | null;
  triggers: TriggerRow[];
  vocabulary: AskVocabularyEntry[];
  artifacts: TodayArtifact[];
  /** Drop a run the person just stopped — the runtime dropped its checkpoint. */
  dropRun: (runRef: string) => void;
}

export function useTodayReads(token: string | undefined, addressee: string | null, libraryScope: 'person' | 'other'): TodayReads {
  const [parked, setParked] = useState<TodayReads['parked']>(null);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [vocabulary, setVocabulary] = useState<AskVocabularyEntry[]>([]);
  const [artifacts, setArtifacts] = useState<TodayArtifact[]>([]);
  useEffect(() => {
    if (!token || !addressee) return;
    let live = true;
    void listRuns({ token }, addressee as Address).then((rs) => { if (live) setParked(rs as TodayReads['parked']); }).catch(() => { if (live) setParked([]); });
    void listTriggers({ token }, addressee as Address).then((ts) => { if (live) setTriggers(ts); }).catch(() => undefined);
    void homeVocabulary(addressee).then((v) => { if (live) setVocabulary(v); }).catch(() => undefined);
    const scopeQ = libraryScope === 'person' ? '' : `?org=${addressee}`;
    void fetch(`/connect/library${scopeQ}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { artifacts: [] }))
      .then((b: { artifacts?: Array<{ id: string; name: string; kind?: string; folder?: string; createdAt?: number; version?: number; isFolder?: boolean }> }) => {
        if (!live) return;
        setArtifacts((b.artifacts ?? []).filter((a) => !a.isFolder && typeof a.createdAt === 'number').map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt as number, ...(a.kind ? { kind: a.kind } : {}), ...(a.folder ? { folder: a.folder } : {}), ...(a.version ? { version: a.version } : {}) })));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [token, addressee, libraryScope]);
  return { parked, triggers, vocabulary, artifacts, dropRun: (runRef) => setParked((p) => (p ?? []).filter((r) => r.runRef !== runRef)) };
}
