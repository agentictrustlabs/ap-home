'use client';
// WHAT THE PLAYBOOK ASKS ON ITS OWN — spec 370 P5 / spec 375 W3. The agent's schedule, as its stewards read
// it: each row's kind, what fires it, what the last firing reached, and — for a webhook — the door's token,
// with rotate. Screen parity with the rows the Worker keeps on the agent's own object; nothing here is
// authority: a trigger adds a clock or a door, and every act a fired run reaches still parks for a mandate.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { BusyButton } from '../shared/BusyButton';
import { listTriggers, fireTrigger, rotateTrigger, triggerSourceLabel, type TriggerRow } from '../../home/ask';
import { StatePill } from './StatePill';
import { stateOf } from '../../home/run-state';

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '');

export function TriggersPanel({ agent }: { agent: Address }) {
  const { session } = useSession();
  const [rows, setRows] = useState<TriggerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<string | null>(null);
  const hookUrl = (id: string) => (typeof window !== 'undefined' ? `${window.location.origin}/a2a/harness/hooks/${agent.toLowerCase()}/${id}` : `/a2a/harness/hooks/${agent.toLowerCase()}/${id}`);

  const load = useCallback(async () => {
    if (!session) return;
    try { setRows(await listTriggers(session, agent)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setRows([]); }
  }, [session?.token, agent]);
  useEffect(() => { void load(); }, [load]);

  const fire = async (id: string) => {
    if (!session) return;
    setBusy(`fire:${id}`); setNote(null);
    try { const out = await fireTrigger(session, agent, id); setNote(`${id}: ${out.outcome}${out.said ? ` — ${out.said.slice(0, 160)}` : ''}`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const rotate = async (id: string) => {
    if (!session) return;
    setBusy(`rotate:${id}`); setNote(null);
    try { await rotateTrigger(session, agent, id); setNote(`${id}: a new token — the old one no longer opens the door.`); setShown((s) => ({ ...s, [id]: true })); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  if (rows === null) return null;
  return (
    <div style={{ marginTop: '1.2rem' }} data-testid="triggers-panel">
      <h3 style={{ margin: '0 0 .3rem', fontSize: '.95rem' }}>What it asks on its own</h3>
      <p className="manage-card-blurb" style={{ margin: '0 0 .6rem' }}>
        The playbook's triggers: a clock, an Endeavor event, an inbound message, or a hook another system calls.
        Each starts a run with the agent as the asker, holding nothing — an answer is posted where you read; an act
        waits in your unfinished asks for a mandate. <strong>A token or a schedule is admission, never authority.</strong>
      </p>
      {error && <p role="alert" className="manage-card-blurb" style={{ color: 'var(--color-danger, #b3261e)' }}>{error}</p>}
      {note && <p role="status" className="manage-card-blurb" style={{ color: 'var(--color-sage-700)' }}>{note}</p>}
      {rows.length === 0 ? (
        <p className="manage-card-blurb">This playbook declares no triggers — the agent asks nothing on its own.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '.5rem' }}>
          {rows.map((r) => (
            <li key={r.triggerId} style={{ border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 8, padding: '.55rem .7rem', fontSize: '.82rem' }} data-testid={`trigger-${r.triggerId}`}>
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{r.triggerId}</strong>
                <span style={{ color: 'var(--color-text-muted)', fontSize: '.72rem' }}>{r.kind ?? 'schedule'}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }}>
                  <BusyButton busy={busy === `fire:${r.triggerId}`} busyLabel="Running…" className="btn btn-ghost" style={{ width: 'auto', fontSize: '.72rem' }} onClick={() => void fire(r.triggerId)} disabled={!!busy}>Run now</BusyButton>
                  {(r.kind === 'webhook') && (
                    <BusyButton busy={busy === `rotate:${r.triggerId}`} busyLabel="Rotating…" className="btn btn-ghost" style={{ width: 'auto', fontSize: '.72rem' }} onClick={() => void rotate(r.triggerId)} disabled={!!busy}>Rotate token</BusyButton>
                  )}
                </span>
              </div>
              <div style={{ marginTop: '.2rem' }}>“{r.ask}”</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: '.15rem' }}>{triggerSourceLabel(r, r.kind === 'webhook' ? hookUrl(r.triggerId) : undefined)}{r.nextAt ? ` · next ${when(r.nextAt)}` : ''}</div>
              {r.kind === 'webhook' && r.token && (
                <div style={{ marginTop: '.25rem', fontFamily: 'ui-monospace, monospace', fontSize: '.72rem', wordBreak: 'break-all' }}>
                  <button type="button" className="btn btn-ghost" style={{ width: 'auto', fontSize: '.7rem', marginRight: '.4rem' }} onClick={() => setShown((s) => ({ ...s, [r.triggerId]: !s[r.triggerId] }))}>{shown[r.triggerId] ? 'Hide token' : 'Show token'}</button>
                  {shown[r.triggerId] ? <span data-testid={`trigger-token-${r.triggerId}`}>Authorization: Bearer {r.token}</span> : <span>Authorization: Bearer ••••••••</span>}
                </div>
              )}
              {r.lastAt && (
                <div style={{ color: 'var(--color-text-muted)', marginTop: '.2rem' }}>
                  last: {r.lastOutcome ? <StatePill state={stateOf({ kind: 'trigger', lastOutcome: r.lastOutcome })} native={r.lastOutcome} compact /> : <strong>?</strong>} {when(r.lastAt)}{r.lastRunRef ? ` · run ${r.lastRunRef.slice(0, 22)}…` : ''}{r.lastSaid ? ` — ${r.lastSaid.slice(0, 140)}` : ''}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
