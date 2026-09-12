'use client';
// WHAT MY AGENT DID — spec 381 W3, the listing. The runs this person asked of an agent, newest first, each
// with its goal, when it finished, how it ended and how many steps and receipts it left; open one and the
// inspector draws it artifact-first (RunInspector, spec 398 §5.2 — outcome · artifacts · decisions · plan and
// authority · execution detail · provenance). Read from the agent's own records under the person's session:
// the Worker lists only the runs they asked for, and refuses the rest.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { listRunRecords, type RunRecordRow } from '../../../home/ask';
import { RunInspector } from './RunInspector';
import { StatePill } from '../StatePill';
import { Section, List, Row, Empty, Unknown, Meta, Button } from '../../../ui';
import { stateOf, type RunStateSource } from '../../../home/run-state';

/** A finished run's record carries its `outcome` (350 `RunOutcome`); the pill shows the projected state (398 §5.1). */
const sourceOf = (r: RunRecordRow): RunStateSource => ({ kind: 'run', outcome: r.outcome as Extract<RunStateSource, { kind: 'run' }>['outcome'], ...(r.canceled ? { canceled: true } : {}) });
/** Spec 398 §5.3 — a canceled run says what stood: "stopped after step N; steps 1–N happened". */
const canceledWords = (c: NonNullable<RunRecordRow['canceled']>): string =>
  c.afterSteps === 0 ? 'stopped before any step ran' : `stopped after step ${c.afterSteps}; step${c.afterSteps === 1 ? ' 1' : `s 1–${c.afterSteps}`} happened`;

export function RunHistory({ token, addressee, limit = 25 }: { token: string; addressee: Address; limit?: number }) {
  const [rows, setRows] = useState<RunRecordRow[] | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // 398 §6.3 — a listing that could not be read is said; it is never rendered as "no runs".
    void listRunRecords({ token }, addressee).then((r) => { if (live) setRows(r.records.sort((a, b) => b.at - a.at)); }).catch((e) => { if (live) { setUnknown(e instanceof Error ? e.message : String(e)); setRows([]); } });
    return () => { live = false; };
  }, [token, addressee]);
  const shown = (rows ?? []).slice(0, limit);
  return (
    <Section title="What this agent did" count={rows?.length || undefined} testId="run-history" aside={<span>every run you asked of it, from its own records — opened, each step, its authority, its provenance</span>}>
      {rows === null && <Meta>Reading the runs back…</Meta>}
      {unknown && <Unknown read={<>the runs could not be read ({unknown})</>} testId="runs-unknown" />}
      {rows !== null && rows.length === 0 && !unknown && <Empty>No finished runs of yours here yet. Ask something, and it appears.</Empty>}
      {shown.length > 0 && (
        <List>
          {shown.map((r) => {
            const goal = r.intent?.goal ?? r.runRef;
            const isOpen = open === r.runRef;
            return (
              <Row
                key={r.runRef}
                title={goal.length > 140 ? `${goal.slice(0, 137)}…` : goal}
                meta={<>{r.steps} step{r.steps === 1 ? '' : 's'} · {r.receipts} receipt{r.receipts === 1 ? '' : 's'}{r.export?.ok ? ' · in the vault' : ''}{r.canceled ? ` · ${canceledWords(r.canceled)}${r.canceled.note ? ` — “${r.canceled.note}”` : ''}` : ''}</>}
                side={<>
                  <StatePill state={stateOf(sourceOf(r))} native={r.canceled ? canceledWords(r.canceled) : r.outcome} compact />
                  <span className="ui-row-time">{new Date(r.at).toLocaleString()}</span>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(isOpen ? null : r.runRef)}>{isOpen ? 'Close' : 'Inspect'}</Button>
                </>}
              >
                {isOpen && <RunInspector token={token} addressee={addressee} runRef={r.runRef} {...(r.intent?.goal ? { goal: r.intent.goal } : {})} />}
              </Row>
            );
          })}
        </List>
      )}
    </Section>
  );
}
