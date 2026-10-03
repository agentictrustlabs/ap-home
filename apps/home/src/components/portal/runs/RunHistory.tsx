'use client';
// WHAT THIS AGENT DID — spec 381 W3, on the UI system v2. Every run the person asked of this agent, from its own
// records: grouped by day, filterable by state (needs you · running · finished · failed · stopped), searchable by
// what was asked, each row the projected state (398 §5.1), the step and receipt counts, when — and Inspect opens
// the run in a DRAWER (its steps, authority, provenance) so the list stays where it was. Runs still waiting are
// listed first under "Needs you" because that is what a person opens this page for.
import { useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRunRecords, type RunRecordRow } from '../../../home/ask';
import { RunInspector } from './RunInspector';
import { StatePill } from '../StatePill';
import { List, Row, Panel, Stats, Stat, FilterChip, SearchInput, DayHeader, Drawer, Button, timeLabel, type PanelState } from '../../../ui';
import { stateOf, stateTone, type RunStateSource } from '../../../home/run-state';
import { ClockIcon } from '../today-icons';
import { facetsOf, applyFacets, threadsOf, FACET_LABELS, fmtMs, turnMsOf, turnTokensOf, type FacetKey } from '../../../home/run-trace-view';

/** A finished run's record carries its `outcome` (350 `RunOutcome`); the pill shows the projected state (398 §5.1). */
const sourceOf = (r: RunRecordRow): RunStateSource => ({ kind: 'run', outcome: r.outcome as Extract<RunStateSource, { kind: 'run' }>['outcome'], ...(r.canceled ? { canceled: true } : {}) });
/** Spec 398 §5.3 — a canceled run says what stood: "stopped after step N; steps 1–N happened". */
const canceledWords = (c: NonNullable<RunRecordRow['canceled']>): string =>
  c.afterSteps === 0 ? 'stopped before any step ran' : `stopped after step ${c.afterSteps}; step${c.afterSteps === 1 ? ' 1' : `s 1–${c.afterSteps}`} happened`;

type Filter = 'all' | 'attention' | 'active' | 'done' | 'bad' | 'stopped';
const FILTERS: Array<{ id: Filter; label: string }> = [{ id: 'all', label: 'All' }, { id: 'attention', label: 'Needs you' }, { id: 'active', label: 'Running' }, { id: 'done', label: 'Finished' }, { id: 'bad', label: 'Failed' }, { id: 'stopped', label: 'Stopped' }];
function bucketOf(r: RunRecordRow): Exclude<Filter, 'all'> {
  if (r.canceled) return 'stopped';
  const t = stateTone(stateOf(sourceOf(r)));
  return t === 'attention' || t === 'uncertain' ? 'attention' : t === 'active' ? 'active' : t === 'bad' ? 'bad' : 'done';
}
const dayKey = (at: number) => new Date(at).toDateString();

export function RunHistory({ token, addressee, limit = 60 }: { token: string; addressee: Address; limit?: number }) {
  const [rows, setRows] = useState<RunRecordRow[] | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [open, setOpen] = useState<RunRecordRow | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [shownLimit, setShownLimit] = useState(limit);
  // Spec 415 A3 — LangSmith's run filters and Threads: facet by skill · capability · model · planner · door, and group a
  // conversation's runs by its A2A contextId.
  const [facets, setFacets] = useState<Partial<Record<FacetKey, string>>>({});
  const [threads, setThreads] = useState(false);
  useEffect(() => {
    let live = true;
    setRows(null); setUnknown(null);
    void listRunRecords({ token }, addressee).then((r) => {
      if (!live) return;
      // Spec 423 L1 — "What this agent did" is a log of what the PERSON asked. An app background poll (the bell
      // checking invitations every 60s) is traced for forensics but is not a deliberate ask, so it is kept out of
      // this list by its door kind. (It remains in the full trace store, reachable by the operator view.)
      const sorted = r.records.filter((x) => x.door?.kind !== 'background').sort((a, b) => b.at - a.at);
      setRows(sorted);
      // Spec 406 W1 — `?run=<runRef>` (the operator view's rows link here): open THAT run's inspector — the evidence.
      try { const want = new URL(window.location.href).searchParams.get('run'); const hit = want ? sorted.find((x) => x.runRef === want) : undefined; if (hit) setOpen(hit); } catch { /* no URL */ }
    }).catch((e) => { if (live) { setUnknown(e instanceof Error ? e.message : String(e)); setRows([]); } });
    return () => { live = false; };
  }, [token, addressee]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, attention: 0, active: 0, done: 0, bad: 0, stopped: 0 };
    for (const r of rows ?? []) { c.all += 1; c[bucketOf(r)] += 1; }
    return c;
  }, [rows]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return applyFacets((rows ?? []).filter((r) => (filter === 'all' || bucketOf(r) === filter) && (!needle || (r.intent?.goal ?? r.runRef).toLowerCase().includes(needle) || r.runRef.toLowerCase().includes(needle))), facets);
  }, [rows, filter, q, facets]);
  const facetValues = useMemo(() => facetsOf(rows ?? []), [rows]);
  const threadGroups = useMemo(() => (threads ? threadsOf(filtered) : []), [threads, filtered]);
  const shown = filtered.slice(0, shownLimit);
  const groups = useMemo(() => { const g: Array<{ day: number; rows: RunRecordRow[] }> = []; for (const r of shown) { const last = g[g.length - 1]; if (last && dayKey(last.day) === dayKey(r.at)) last.rows.push(r); else g.push({ day: r.at, rows: [r] }); } return g; }, [shown]);
  const state: PanelState = rows === null ? 'loading' : unknown ? 'unknown' : filtered.length ? 'ready' : 'empty';
  const emptyWords = rows && rows.length && (q || filter !== 'all') ? { title: 'No run matches', hint: q ? `Nothing you asked of this agent mentions “${q}”.` : `No run is ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} right now.` } : { title: 'No runs yet', hint: 'Ask something of this agent, and it appears here with every step it took.' };

  return (
    <>
      <Stats>
        <Stat label="Needs you" value={counts.attention} loading={rows === null} tone={counts.attention ? 'warn' : undefined} hint="waiting on a signature or an answer" />
        <Stat label="Running" value={counts.active} loading={rows === null} hint="in motion now" />
        <Stat label="Finished" value={counts.done} loading={rows === null} tone="ok" hint="completed with receipts" />
        <Stat label="Failed or stopped" value={counts.bad + counts.stopped} loading={rows === null} tone={counts.bad ? 'danger' : undefined} hint="refused, failed, or stopped by you" />
      </Stats>
      <div className="ui-toolbar">
        <SearchInput placeholder="Search what was asked…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search runs" />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => <FilterChip key={f.id} active={filter === f.id} count={rows ? counts[f.id] : undefined} onClick={() => setFilter(f.id)}>{f.label}</FilterChip>)}
          <FilterChip active={threads} onClick={() => setThreads((t) => !t)} data-testid="run-threads-toggle">Threads</FilterChip>
        </div>
      </div>
      <div className="ui-toolbar" data-testid="run-facets" style={{ flexWrap: 'wrap', gap: 8 }}>
        {(Object.keys(FACET_LABELS) as FacetKey[]).filter((k) => facetValues[k].length).map((k) => (
          <label key={k} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
            <span className="ui-micro">{FACET_LABELS[k]}</span>
            <select value={facets[k] ?? ''} onChange={(e) => setFacets((f) => ({ ...f, [k]: e.target.value || undefined }))} data-testid={`run-facet-${k}`} aria-label={`Filter by ${FACET_LABELS[k].toLowerCase()}`}>
              <option value="">any</option>
              {facetValues[k].map((v) => <option key={v.value} value={v.value}>{v.value} ({v.count})</option>)}
            </select>
          </label>
        ))}
      </div>
      <Panel title="What this agent did" icon={<ClockIcon />} count={filtered.length} state={state} rows={5} testId="run-history"
        aside={<span>every run you asked of it — opened, each step, its authority, its provenance</span>}
        empty={{ icon: <ClockIcon />, ...emptyWords }}
        unknown={{ read: <>the runs could not be read ({unknown})</> }}>
        <div style={{ padding: '0 var(--sp-4) var(--sp-3)' }}>
          {threads && threadGroups.map((t) => (
            <div key={t.id} data-testid="run-thread">
              <p className="ui-micro" style={{ margin: 'var(--sp-3) 0 var(--sp-1)' }}>{t.contextId ? `conversation ${t.contextId.slice(0, 18)}` : 'a single run'} · {t.runs.length} turn{t.runs.length === 1 ? '' : 's'}
                {/* Spec 418 §3 — the thread's totals over the turns that recorded them (never a zero for "not recorded"). */}
                <span data-testid="run-thread-totals">{t.totals.ms !== undefined ? ` · ${fmtMs(t.totals.ms)}${t.totals.timed < t.totals.turns ? ` over ${t.totals.timed}` : ''}` : ' · time not recorded'}
                {t.totals.tokens !== undefined ? ` · ${t.totals.tokens.toLocaleString()} tokens${t.totals.counted < t.totals.turns ? ` over ${t.totals.counted}` : ''}` : ' · tokens not reported'}</span>
                {' '}· {timeLabel(t.lastAt)}</p>
              <List>
                {t.runs.map((r) => (
                  <Row key={r.runRef} title={(r.intent?.goal ?? r.runRef).slice(0, 140)}
                    meta={<>{r.steps} step{r.steps === 1 ? '' : 's'}{r.variant?.plannerKind ? ` · planner ${r.variant.plannerKind}` : ''}{r.skills?.length ? ` · ${r.skills.length} skill${r.skills.length === 1 ? '' : 's'}` : ''}{turnMsOf(r) !== undefined ? ` · ${fmtMs(turnMsOf(r))}` : ''}{turnTokensOf(r) !== undefined ? ` · ${turnTokensOf(r)!.toLocaleString()} tokens` : ''}</>}
                    side={<><StatePill state={stateOf(sourceOf(r))} native={r.outcome} compact /><Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Inspect</Button></>} />
                ))}
              </List>
            </div>
          ))}
          {!threads && groups.map((g) => (
            <div key={dayKey(g.day)}>
              <DayHeader at={g.day} />
              <List>
                {g.rows.map((r) => {
                  const goal = r.intent?.goal ?? r.runRef;
                  return (
                    <Row key={r.runRef} title={goal.length > 140 ? `${goal.slice(0, 137)}…` : goal}
                      meta={<>{r.steps} step{r.steps === 1 ? '' : 's'} · {r.receipts} receipt{r.receipts === 1 ? '' : 's'}{r.export?.ok ? ' · in the vault' : ''}{r.canceled ? ` · ${canceledWords(r.canceled)}${r.canceled.note ? ` — “${r.canceled.note}”` : ''}` : ''}</>}
                      side={<>
                        <StatePill state={stateOf(sourceOf(r))} native={r.canceled ? canceledWords(r.canceled) : r.outcome} compact />
                        <span className="ui-row-time" title={new Date(r.at).toLocaleString()}>{timeLabel(r.at)}</span>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Inspect</Button>
                      </>} />
                  );
                })}
              </List>
            </div>
          ))}
          {filtered.length > shownLimit && <div style={{ padding: 'var(--sp-3) 0 0', textAlign: 'center' }}><Button variant="secondary" size="sm" onClick={() => setShownLimit((n) => n + limit)}>Show {Math.min(limit, filtered.length - shownLimit)} more of {filtered.length - shownLimit}</Button></div>}
        </div>
      </Panel>
      {open && (
        <Drawer title={<span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>Run <StatePill state={stateOf(sourceOf(open))} compact /></span>} onClose={() => setOpen(null)}>
          <p className="ui-note" style={{ fontSize: 'var(--fs-md)', color: 'var(--color-text-primary)', fontWeight: 600 }}>{open.intent?.goal ?? open.runRef}</p>
          <p className="ui-micro">{new Date(open.at).toLocaleString()} · <code className="ui-mono">{open.runRef}</code></p>
          <RunInspector token={token} addressee={addressee} runRef={open.runRef} {...(open.intent?.goal ? { goal: open.intent.goal } : {})} />
        </Drawer>
      )}
    </>
  );
}
