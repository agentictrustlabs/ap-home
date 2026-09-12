'use client';
// ROUTINES — spec 398 G3, the product page for spec 375's triggers: each routine as a VERSIONED SKILL (the playbook by
// id · version · digest) + a TRIGGER (what fires it) + FRESH AUTHORITY (every firing asks as the agent holding nothing;
// an act parks for a steward's mandate, never one carried over) + its RUN HISTORY, state (§5.1), budget and bill (§5.4),
// and PAUSE (§5.3 — a routine's own control: nothing new starts, state kept; the run it parked stands). Stewards only:
// the runtime refuses everyone else, and this page says so.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { listTriggers, listRunRecords, pauseTrigger, fireTrigger, type TriggerRow, type RunRecordRow } from '../../home/ask';
import { assembleRoutines, type RoutineView } from '../../home/routines';
import { StatePill } from './StatePill';
import { BusyButton } from '../shared/BusyButton';
import { workspaceHref, type WorkspaceScope } from '../../lib/workspace';
import { Card, KeyValue, Empty, Unknown, ErrorNote, Meta, Micro, Mono, Note, Button } from '../../ui';

async function readAssignment(token: string, agent: string): Promise<{ archetypeId: string; archetypeVersion: string; definitionDigest: string } | null> {
  const r = await fetch('/connect/channels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'archetypeAssignmentGet', communityId: agent.toLowerCase() }) });
  const b = (await r.json().catch(() => ({}))) as { ok?: boolean; record?: { archetypeId: string; archetypeVersion: string; definitionDigest: string } | null };
  return r.ok && b.ok && b.record ? { archetypeId: b.record.archetypeId, archetypeVersion: b.record.archetypeVersion, definitionDigest: b.record.definitionDigest } : null;
}

export function RoutinesView({ scope }: { scope: WorkspaceScope }) {
  const { session, agentAddress } = useSession();
  const agent = (scope.kind === 'org' ? scope.org : scope.kind === 'service' ? scope.agent : agentAddress ?? '').toLowerCase() as Address;
  const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
  const [records, setRecords] = useState<RunRecordRow[]>([]);
  const [assignment, setAssignment] = useState<{ archetypeId: string; archetypeVersion: string; definitionDigest: string } | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!session || !agent) return;
    const token = session.token;
    setUnknown(null);
    try { setTriggers(await listTriggers({ token }, agent)); } catch (e) { setUnknown(e instanceof Error ? e.message : String(e)); setTriggers([]); }
    void listRunRecords({ token }, agent).then((r) => setRecords(r.records)).catch(() => undefined);
    void readAssignment(token, agent).then(setAssignment).catch(() => undefined);
  }, [session?.token, agent]);
  useEffect(() => { void load(); }, [load]);

  const routines = useMemo(() => assembleRoutines({ triggers: triggers ?? [], records, assignment }), [triggers, records, assignment]);

  const change = async (r: RoutineView, c: { paused?: boolean; note?: string; budget?: { vaultCalls: number } | null }) => {
    if (!session) return;
    setBusy(`${r.triggerId}:${Object.keys(c).join('+')}`); setErr(null);
    const out = await pauseTrigger(session, agent, r.triggerId, c);
    setBusy(null);
    if (!out.ok) { setErr(out.error); return; }
    await load();
  };
  const fire = async (r: RoutineView) => {
    if (!session) return;
    setBusy(`${r.triggerId}:fire`); setErr(null);
    try { await fireTrigger(session, agent, r.triggerId); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null); await load();
  };

  if (!session) return null;
  return (
    <div data-testid="routines">
      <Note>
        A routine is a <b>versioned skill</b> (the playbook, by digest) with a <b>trigger</b>. Every firing asks as the agent holding nothing: a read answers; an act parks for a steward&rsquo;s mandate — fresh each time, never carried over. Pausing stops new firings and keeps everything; the budget is vault calls per firing, and going over pauses the routine rather than widening anything.
      </Note>
      {unknown && <Unknown read={<>the schedule could not be read ({unknown})</>} testId="routines-unknown" />}
      {err && <ErrorNote>{err}</ErrorNote>}
      {triggers === null && !unknown && <Meta>Reading the schedule…</Meta>}
      {triggers !== null && routines.length === 0 && !unknown && <Empty title="No routines">This agent&rsquo;s playbook declares no triggers. <a href={workspaceHref(scope, 'playbook')}>Choose a playbook →</a></Empty>}
      {routines.map((r) => (
        <Card key={r.triggerId} title={<>&ldquo;{r.ask}&rdquo;</>} head={<StatePill state={r.state} native={r.native} />} testId={`routine-${r.triggerId}`}>
          <div data-state={r.state.state} />
          <KeyValue rows={[
            ['trigger', <>{r.source}{r.nextAt ? ` · next ${new Date(r.nextAt).toLocaleString()}` : ''}</>],
            ['skill', r.playbook ? <>{r.playbook.archetypeId} v{r.playbook.version} · <Mono>{r.playbook.digest.slice(0, 14)}…</Mono> <a href={workspaceHref(scope, 'playbook')}>playbook →</a></> : 'no playbook read — the row names its digest on the runtime', { absent: !r.playbook }],
            ['authority', r.authority],
            ['budget', <span style={{ display: 'inline-flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              {r.budget ? `${r.budget} vault calls per firing · ${r.budgetBy === 'playbook' ? 'declared by the playbook' : 'set by a steward'}` : 'none set'}{r.lastBill ? ` · last firing cost ${r.lastBill.vaultCalls} vault calls, ${r.lastBill.doRequests} serving requests` : ''}
              <input className="input" type="number" min="1" placeholder="vault calls" value={budgetDraft[r.triggerId] ?? ''} onChange={(e) => setBudgetDraft((d) => ({ ...d, [r.triggerId]: e.target.value }))} style={{ width: 96, fontSize: 'var(--fs-sm)', padding: '3px 8px', minHeight: 26 }} />
              <BusyButton busy={busy === `${r.triggerId}:budget`} busyLabel="Setting…" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!budgetDraft[r.triggerId]} onClick={() => void change(r, { budget: { vaultCalls: Number(budgetDraft[r.triggerId]) } })}>Set</BusyButton>
              {r.budget && <Button size="sm" variant="ghost" onClick={() => void change(r, { budget: null })}>Clear</Button>}
            </span>, { absent: !r.budget }],
            ['last', r.last ? `${r.last.outcome} · ${new Date(r.last.at).toLocaleString()}${r.last.said ? ` — ${r.last.said.slice(0, 120)}` : ''}` : 'never fired', { absent: !r.last }],
            ...(r.paused ? [['paused', <>by {r.paused.by} · {new Date(r.paused.at).toLocaleString()}{r.paused.note ? ` — ${r.paused.note}` : ''}</>] as [React.ReactNode, React.ReactNode]] : []),
          ]} />
          <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            {r.paused
              ? <BusyButton busy={busy === `${r.triggerId}:paused`} busyLabel="Resuming…" className="ui-btn ui-btn--primary ui-btn--sm" onClick={() => void change(r, { paused: false })} data-testid="routine-resume">Resume</BusyButton>
              : <BusyButton busy={busy === `${r.triggerId}:paused`} busyLabel="Pausing…" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => { const note = typeof window !== 'undefined' ? (window.prompt('Pause this routine? Nothing new starts; what it parked stands. A note (optional):') ?? null) : ''; if (note !== null) void change(r, { paused: true, ...(note.trim() ? { note: note.trim() } : {}) }); }} data-testid="routine-pause">Pause</BusyButton>}
            <BusyButton busy={busy === `${r.triggerId}:fire`} busyLabel="Firing…" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!!r.paused} onClick={() => void fire(r)} title="Run it now, as the alarm would">Fire now</BusyButton>
            <Micro>pause ≠ cancel ≠ revoke</Micro>
          </div>
          <details style={{ marginTop: 'var(--sp-3)' }}>
            <summary className="ui-meta" style={{ cursor: 'pointer' }}>history · {r.history.length} firing{r.history.length === 1 ? '' : 's'} on record</summary>
            {r.history.length === 0 && <Meta>No firing on record yet (records keep a week).</Meta>}
            {r.history.map((h) => (
              <div key={h.runRef} style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', padding: '3px 0' }} className="ui-meta">
                <span className="ui-row-time">{new Date(h.at).toLocaleString()}</span>
                <StatePill state={h.state} native={h.native} compact />
                <span>{h.steps} step{h.steps === 1 ? '' : 's'} · {h.receipts} receipt{h.receipts === 1 ? '' : 's'}{h.bill ? ` · ${h.bill.vaultCalls} vault calls` : ''}</span>
                <a href={workspaceHref(scope, 'activities')}>inspect →</a>
              </div>
            ))}
          </details>
        </Card>
      ))}
    </div>
  );
}
