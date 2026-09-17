'use client';
// OPERATIONS — spec 406 W1: the operator view LangSmith and MAF ship, over OUR records. Counts, kinds, capabilities,
// providers, latency percentiles, the bill, the failure classes — a window over everything the person stewards. Every
// row names a run; the run inspector is the evidence. This screen counts; it never testifies.
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../context/session';
import { PageHead, Section, Stats, Stat, List, Row, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, Tabs, SkeletonRows } from '../../ui';
import { AgentName } from '../shared/AgentName';
import { operatorView, rebuildOperatorIndex, type OpsSummaryView } from '../../home/ask';

type Window = '24h' | '7d' | '30d';
const ms = (n: number | null) => (n === null ? '—' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The person's own runs live at /activities; an organization's at its own Activities page. */
const agentActivitiesHref = (agent: string, me: string) => (agent.toLowerCase() === me.toLowerCase() ? '/activities' : `/org/${agent}/activities`);
const kindTone = (k: string): 'ok' | 'warn' | 'danger' | undefined => (k === 'answer' ? 'ok' : k === 'authority_required' || k === 'prompt' ? 'warn' : k === 'error' || k === 'refused' ? 'danger' : undefined);

export function OperationsView() {
  const { session } = useSession();
  const [window_, setWindow] = useState<Window>('7d');
  const [summary, setSummary] = useState<OpsSummaryView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | false>(false);
  const load = useCallback(async (w: Window) => {
    if (!session) return;
    setError(null);
    const r = await operatorView({ token: session.token }, { scope: 'estate', window: w });
    if (r.ok) setSummary(r.summary); else { setSummary(null); setError(r.error); }
  }, [session]);
  useEffect(() => { void load(window_); }, [load, window_]);
  const rebuild = async () => {
    if (!session) return;
    setBusy('Rebuilding…');
    const r = await rebuildOperatorIndex({ token: session.token }, { scope: 'estate' }, (done, total) => setBusy(`Rebuilding… ${done}/${total} agents`));
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await load(window_);
  };
  const t = summary?.totals;
  const pctOf = (n: number) => (t && t.runs ? `${Math.round((100 * n) / t.runs)}%` : '—');
  return (
    <>
      <PageHead title="Operations" description="What your agents did, as an operator sees it — counts, kinds, capabilities, providers, latency, the bill, the failure classes. A projection over the records: every row opens the run, and the run is the evidence." actions={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Tabs value={window_} onChange={setWindow} items={[{ id: '24h', label: '24 h' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }]} label="window" /><Button size="sm" onClick={() => void rebuild()} disabled={!!busy}>{busy || 'Rebuild from the records'}</Button></div>} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {summary === undefined ? <SkeletonRows rows={3} lead /> : summary === null ? <Empty title="No operator index on this deployment">The runtime keeps no OPS index; the records still hold everything.</Empty> : (
        <>
          <Stats>
            <Stat label="runs" value={t!.runs} hint={`${summary.agents.length} agent${summary.agents.length === 1 ? '' : 's'}`} />
            <Stat label="answered" value={pctOf(t!.answered)} hint={`${t!.answered}`} tone="ok" />
            <Stat label="parked for authority" value={pctOf(t!.parked)} hint={`${t!.parked} · ${t!.prompted} prompted`} />
            <Stat label="refused · errored" value={`${t!.refused} · ${t!.errored}`} hint={`${t!.canceled} canceled`} tone={t!.errored ? 'danger' : undefined} />
            <Stat label="latency p50 · p95" value={`${ms(t!.p50Ms)} · ${ms(t!.p95Ms)}`} />
            <Stat label="vault calls · DO requests" value={`${t!.vaultCalls} · ${t!.doRequests}`} hint={`${t!.steps} steps · ${t!.receipts} receipts`} />
          </Stats>
          {summary.byFailure.length > 0 && (
            <Section title="Failure classes" count={summary.byFailure.length}>
              <List>{summary.byFailure.map((f) => <Row key={f.failureClass} title={<span><Chip tone="danger">{f.failureClass}</Chip> {f.runs} run{f.runs === 1 ? '' : 's'}</span>} meta={f.sample ?? ''} />)}</List>
            </Section>
          )}
          <Section title="By capability" count={summary.byCapability.length}>
            {summary.byCapability.length === 0 ? <Empty title="Nothing ran in this window" /> : <List>{summary.byCapability.map((c) => <Row key={c.capability} title={<Mono>{c.capability}</Mono>} meta={`${c.runs} run${c.runs === 1 ? '' : 's'} · ${c.answered} answered · ${c.parked} parked · ${c.errored} errored · p50 ${ms(c.p50Ms)}`} />)}</List>}
          </Section>
          <Section title="By agent" count={summary.byAgent.length}>
            <List>{summary.byAgent.map((a) => <Row key={a.agent} title={<AgentName address={a.agent} />} meta={`${a.runs} runs · ${a.answered} answered · ${a.parked} parked · ${a.errored} errored · ${a.vaultCalls} vault calls`} side={<a href={`/estate`}>estate</a>} />)}</List>
          </Section>
          <Section title="By provider" count={summary.byProvider.length}>
            <List>{summary.byProvider.map((p) => <Row key={p.provider} title={p.provider} meta={`${p.runs} runs · p50 ${ms(p.p50Ms)} · p95 ${ms(p.p95Ms)}`} />)}</List>
          </Section>
          <Section title="By day" count={summary.byDay.length}>
            <List>{summary.byDay.map((d) => <Row key={d.day} title={d.day} meta={`${d.runs} runs · ${d.answered} answered · ${d.parked} parked · ${d.errored} errored · ${d.vaultCalls} vault calls`} />)}</List>
          </Section>
          <Section title="Recent runs" count={summary.recent.length} aside={<Meta>each opens the run — the evidence</Meta>}>
            <List>{summary.recent.map((r) => <Row key={r.run_ref} title={<span><Chip tone={kindTone(r.kind)}>{r.kind}</Chip> {r.capability ? <Mono>{r.capability}</Mono> : <Meta>no step</Meta>}</span>} meta={`${when(r.at)} · ${r.provider ?? 'no model'} · ${ms(r.duration_ms)} · ${r.vault_calls} vault calls${r.failure_class ? ` · ${r.failure_class}` : ''}`} side={<a href={`${agentActivitiesHref(r.agent, summary.agents[0] ?? '')}?run=${encodeURIComponent(r.run_ref)}`}><Mono>{r.run_ref.slice(0, 18)}…</Mono></a>} />)}</List>
          </Section>
        </>
      )}
      <Note>Numbers and ids only — no words, no arguments, no results live in this index. It is serving-plane: wiped, it is rebuilt from the run records (the button). What a counterparty can prove is on the run&rsquo;s inspector and its public projection, never here.</Note>
    </>
  );
}
