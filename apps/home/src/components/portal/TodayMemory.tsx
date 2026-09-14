'use client';
// WHAT YOUR AGENT KNOWS ABOUT YOU — spec 402 W1, on Today. The facts your agent remembers, newest first, each with when
// and who said it; Forget in place; Correct hands the fact to the Ask. Memory shown is memory a person can judge — a
// stale fact is a real record, so its age is on it. The same facts reach every way in (the Home, Claude through the
// Home MCP, a paired runtime), because each asks the same agent.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { Panel, List, Row, Button, Meta, LinkButton, relativeLabel, useReadyReport, type PanelState } from '../../ui';
import { listFacts, forgetFact, type RememberedFact } from '../../home/ask';
import { SparkIcon } from './today-icons';

const who = (f: RememberedFact) => (f.source === 'you' ? 'you told me' : f.source === 'agent' ? 'your agent learned' : `from ${f.from ?? 'a connected account'}`);

export function TodayMemory() {
  const { session } = useSession();
  const [facts, setFacts] = useState<RememberedFact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useReadyReport('memory', facts === null && !err);
  useEffect(() => {
    if (!session?.token) return;
    let live = true;
    listFacts({ token: session.token }).then((f) => { if (live) setFacts(f); }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [session?.token]);

  const forget = async (f: RememberedFact) => {
    if (!session?.token) return;
    setBusy(f.id);
    const r = await forgetFact({ token: session.token }, f.id);
    setBusy(null);
    if (r.ok) setFacts(r.entries); else setErr(r.error);
  };

  const shown = (facts ?? []).slice(0, 5);
  const state: PanelState = facts === null && !err ? 'loading' : err ? 'unknown' : facts?.length ? 'ready' : 'empty';
  return (
    <Panel title="What your agent knows about you" icon={<SparkIcon />} count={facts?.length} state={state} rows={2} testId="today-memory"
      aside={facts?.length ? <a href="/memory">All of it →</a> : undefined}
      empty={{ icon: <SparkIcon />, title: 'Nothing remembered yet', hint: 'Tell your agent something to keep — "remember that I lead the Thursday circle" — and it is here, yours, forgettable.', action: <LinkButton size="sm" href={`/ask?seed=${encodeURIComponent('remember that ')}`}>Tell it something</LinkButton> }}
      unknown={{ read: `your memory could not be read (${err ?? ''})` }}>
      <List>
        {shown.map((f) => (
          <Row key={f.id} title={f.fact} meta={`${who(f)} · ${relativeLabel(Date.parse(f.learnedAt))}`}
            side={<span style={{ display: 'inline-flex', gap: 6 }}>
              <LinkButton size="sm" variant="ghost" href={`/ask?seed=${encodeURIComponent(`${f.fact} — that has changed: `)}`} title="Tell your agent what is true now; the new fact replaces this one">Correct</LinkButton>
              <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => void forget(f)} title="Forget this fact; a receipt that cited it keeps its citation">{busy === f.id ? '…' : 'Forget'}</Button>
            </span>} />
        ))}
      </List>
      {facts && facts.length > 5 && <div style={{ padding: 'var(--sp-2) var(--sp-4)' }}><Meta>{facts.length - 5} more on Memory.</Meta></div>}
    </Panel>
  );
}
