'use client';
// WHAT YOUR AGENT KNOWS ABOUT YOU — spec 402 W1, on Today. The facts your agent remembers, newest first, each with when
// and who said it; Forget in place; Correct hands the fact to the Ask. Memory shown is memory a person can judge — a
// stale fact is a real record, so its age is on it. The same facts reach every way in (the Home, Claude through the
// Home MCP, a paired runtime), because each asks the same agent.
import { useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { activateInteractionsIfNeeded, resolveVia } from '../../home/onboarding';
import { Panel, List, Row, Button, Meta, LinkButton, relativeLabel, useReadyReport, type PanelState } from '../../ui';
import { listFacts, listFactsOrWhy, forgetFact, type RememberedFact } from '../../home/ask';
import { SparkIcon } from './today-icons';

const who = (f: RememberedFact) => (f.source === 'you' ? 'you told me' : f.source === 'agent' ? 'your agent learned' : `from ${f.from ?? 'a connected account'}`);

export function TodayMemory() {
  const { session, agentAddress, profile } = useSession();
  const [facts, setFacts] = useState<RememberedFact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  // A grant signed before `vault:memory.facts` existed denies the record — the memory is ADDITIVE, like the household
  // record: the person re-issues her own interactions grant here (one signature; silent on a KMS home). Never a fallback.
  const scopeBehind = !!err && /record_scope_denied|scope/i.test(err);
  const enable = async () => {
    if (!session?.token || !agentAddress) return;
    setEnabling(true);
    try {
      const r = await activateInteractionsIfNeeded(agentAddress as `0x${string}`, resolveVia(profile?.credential, session.via), { token: session.token }, true);
      if (!r.ok) { setErr(r.error); return; }
      setErr(null); setFacts(await listFacts({ token: session.token }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setEnabling(false); }
  };
  useReadyReport('memory', facts === null && !err);
  useEffect(() => {
    if (!session?.token) return;
    let live = true;
    listFactsOrWhy({ token: session.token }).then((r) => { if (!live) return; if (r.ok) setFacts(r.entries); else setErr(r.error); });
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
  const state: PanelState = facts === null && !err ? 'loading' : scopeBehind ? 'empty' : err ? 'unknown' : facts?.length ? 'ready' : 'empty';
  return (
    <Panel title="What your agent knows about you" icon={<SparkIcon />} count={facts?.length} state={state} rows={2} testId="today-memory"
      aside={facts?.length ? <a href="/memory">All of it →</a> : undefined}
      empty={scopeBehind
        ? { icon: <SparkIcon />, title: 'Memory needs your grant refreshed', hint: 'Your agent\'s grant predates memory. Refresh it once — your signature, nothing else changes — and your agent can keep what you tell it.', action: <Button size="sm" variant="primary" disabled={enabling} onClick={() => void enable()}>{enabling ? 'Refreshing…' : 'Refresh the grant'}</Button> }
        : { icon: <SparkIcon />, title: 'Nothing remembered yet', hint: 'Tell your agent something to keep — "remember that I lead the Thursday circle" — and it is here, yours, forgettable.', action: <LinkButton size="sm" href={`/ask?seed=${encodeURIComponent('remember that ')}`}>Tell it something</LinkButton> }}
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
