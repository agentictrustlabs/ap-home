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
      <p className="manage-card-blurb">
        A routine is a <b>versioned skill</b> (the playbook, by digest) with a <b>trigger</b>. Every firing asks as the agent holding nothing: a read answers; an act <b>parks for a steward&rsquo;s mandate</b> — fresh each time, never carried over. Pausing stops new firings and keeps everything; the budget is vault calls per firing, and going over pauses the routine rather than widening anything.
      </p>
      {unknown && <p style={{ fontSize: '0.8rem', color: 'var(--color-amber-700, #b45309)' }} data-testid="routines-unknown">unknown — the schedule could not be read ({unknown}). Nothing is shown because nothing could be read.</p>}
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{err}</p>}
      {triggers === null && !unknown && <p className="muted" style={{ fontSize: '0.8rem' }}>Reading the schedule…</p>}
      {triggers !== null && routines.length === 0 && !unknown && <p className="muted" style={{ fontSize: '0.8rem' }}>No routines: this agent&rsquo;s playbook declares no triggers. <a href={workspaceHref(scope, 'playbook')}>Choose a playbook →</a></p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {routines.map((r) => (
          <div key={r.triggerId} className="manage-card" style={{ padding: '0.75rem 0.95rem' }} data-testid={`routine-${r.triggerId}`} data-state={r.state.state}>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', flex: 1, minWidth: 200 }}>&ldquo;{r.ask}&rdquo;</span>
              <StatePill state={r.state} native={r.native} />
            </div>
            <div style={{ fontSize: '0.76rem', opacity: 0.75, marginTop: '0.3rem', display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '0.6rem', rowGap: 2 }}>
              <span>trigger</span><span>{r.source}{r.nextAt ? ` · next ${new Date(r.nextAt).toLocaleString()}` : ''}</span>
              <span>skill</span><span>{r.playbook ? <>{r.playbook.archetypeId} v{r.playbook.version} · <code style={{ fontSize: '0.7rem' }}>{r.playbook.digest.slice(0, 14)}…</code> <a href={workspaceHref(scope, 'playbook')}>playbook →</a></> : <span style={{ opacity: 0.6 }}>no playbook read — the row names its digest on the runtime</span>}</span>
              <span>authority</span><span>{r.authority}</span>
              <span>budget</span>
              <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                {r.budget ? `${r.budget} vault calls per firing` : 'none set'}{r.lastBill ? ` · last firing cost ${r.lastBill.vaultCalls} vault calls, ${r.lastBill.doRequests} serving requests` : ''}
                <input type="number" min="1" placeholder="vault calls" value={budgetDraft[r.triggerId] ?? ''} onChange={(e) => setBudgetDraft((d) => ({ ...d, [r.triggerId]: e.target.value }))} style={{ width: 90, fontSize: '0.74rem', padding: '0.1rem 0.3rem' }} />
                <BusyButton busy={busy === `${r.triggerId}:budget`} busyLabel="Setting…" className="btn-ghost" style={{ width: 'auto', fontSize: '0.72rem' }} disabled={!budgetDraft[r.triggerId]} onClick={() => void change(r, { budget: { vaultCalls: Number(budgetDraft[r.triggerId]) } })}>Set budget</BusyButton>
                {r.budget && <button type="button" className="btn-ghost" style={{ fontSize: '0.72rem' }} onClick={() => void change(r, { budget: null })}>Clear</button>}
              </span>
              <span>last</span><span>{r.last ? `${r.last.outcome} · ${new Date(r.last.at).toLocaleString()}${r.last.said ? ` — ${r.last.said.slice(0, 120)}` : ''}` : 'never fired'}</span>
              {r.paused && <><span>paused</span><span>by {r.paused.by} · {new Date(r.paused.at).toLocaleString()}{r.paused.note ? ` — ${r.paused.note}` : ''}</span></>}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {r.paused
                ? <BusyButton busy={busy === `${r.triggerId}:paused`} busyLabel="Resuming…" className="btn-primary" style={{ width: 'auto', fontSize: '0.76rem' }} onClick={() => void change(r, { paused: false })} data-testid="routine-resume">Resume</BusyButton>
                : <BusyButton busy={busy === `${r.triggerId}:paused`} busyLabel="Pausing…" className="btn-ghost" style={{ width: 'auto', fontSize: '0.76rem' }} onClick={() => { const note = typeof window !== 'undefined' ? (window.prompt('Pause this routine? Nothing new starts; what it parked stands. A note (optional):') ?? null) : ''; if (note !== null) void change(r, { paused: true, ...(note.trim() ? { note: note.trim() } : {}) }); }} data-testid="routine-pause">Pause</BusyButton>}
              <BusyButton busy={busy === `${r.triggerId}:fire`} busyLabel="Firing…" className="btn-ghost" style={{ width: 'auto', fontSize: '0.76rem' }} disabled={!!r.paused} onClick={() => void fire(r)} title="Run it now, as the alarm would">Fire now</BusyButton>
              <span style={{ fontSize: '0.7rem', opacity: 0.55 }} title="Pause is not cancel (a parked firing stands) and not revoke (no authority changes hands)">pause ≠ cancel ≠ revoke</span>
            </div>
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ fontSize: '0.76rem', cursor: 'pointer' }}>history · {r.history.length} firing{r.history.length === 1 ? '' : 's'} on record</summary>
              {r.history.length === 0 && <p className="muted" style={{ fontSize: '0.74rem' }}>No firing on record yet (records keep a week).</p>}
              {r.history.map((h) => (
                <div key={h.runRef} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.74rem', alignItems: 'center', padding: '0.15rem 0' }}>
                  <span style={{ opacity: 0.6 }}>{new Date(h.at).toLocaleString()}</span>
                  <StatePill state={h.state} native={h.native} compact />
                  <span>{h.steps} step{h.steps === 1 ? '' : 's'} · {h.receipts} receipt{h.receipts === 1 ? '' : 's'}{h.bill ? ` · ${h.bill.vaultCalls} vault calls` : ''}</span>
                  <a href={workspaceHref(scope, 'activities')} style={{ fontSize: '0.72rem' }}>inspect →</a>
                </div>
              ))}
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}
