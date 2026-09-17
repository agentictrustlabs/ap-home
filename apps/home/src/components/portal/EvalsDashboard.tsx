'use client';
// The evals dashboard (spec 398 §10 / P1.3). Reads the folded JSON `src/evals/dashboard.json`; renders recurring
// failures first, then every gate by night, then the latest `ap eval` cases with the prose that was judged.
import dashboard from '../../evals/dashboard.json';
import { Section, List, Row, Empty, Chip, Mono, Meta, Note, KeyValue } from '../../ui';

type Night = { status: string; cls: string | null; ms: number };
type Gate = { id: string; spec: string; required: boolean; nights: Record<string, Night> };
type Cell = { gate: string; cls: string; spec: string; nights: string[]; required: boolean; sample: string };
type EvalCase = { id: string; incident: string; question: string; passed: boolean; failures: string[]; ms: number; kind: string | null; said: string };
const D = dashboard as { builtAt: string; nightly: { nights: string[]; reports: Array<{ at: string; passed: number; failed: number; total: number }>; gates: Gate[]; recurring: Cell[]; once: Cell[]; classes: Array<{ id: string; why: string }> }; eval: { file: string | null; home: string | null; at: string | null; passed: number; failed: number; cases: EvalCase[] } | null };

const tone = (s: string): 'ok' | 'warn' | 'danger' | undefined => (s === 'passed' ? 'ok' : s === 'skipped' ? undefined : s === 'timed out' ? 'warn' : 'danger');

export function EvalsDashboard() {
  const { nightly, eval: ev } = D;
  return (
    <>
      <Section title="Recurring failures" count={nightly.recurring.length} aside={<Meta>a gate × class seen on two or more nights · {nightly.nights.length} night{nightly.nights.length === 1 ? '' : 's'} on record</Meta>} testId="evals-recurring">
        {nightly.recurring.length === 0 ? <Empty title="Nothing recurs">{nightly.once.length ? `${nightly.once.length} failure(s) seen once — below, by gate.` : 'No failures on record.'}</Empty> : (
          <List>{nightly.recurring.map((c) => <Row key={`${c.gate}|${c.cls}`} title={<span><strong>{c.gate}</strong> <Chip tone="danger">{c.cls}</Chip></span>} meta={<span>{c.nights.join(', ')} · spec {c.spec} · {c.required ? 'required' : 'advisory'} — {c.sample.slice(0, 160)}</span>} />)}</List>
        )}
      </Section>
      {ev && (
        <Section title="Truth cases (ap eval)" count={ev.cases.length} aside={<Meta>{ev.passed}/{ev.passed + ev.failed} hold · {ev.home ?? ''} · {ev.at ? new Date(ev.at).toLocaleString() : ''}</Meta>} testId="evals-cases">
          <List>
            {ev.cases.map((c) => (
              <Row key={c.id} title={<span><Chip tone={c.passed ? 'ok' : 'danger'}>{c.passed ? 'holds' : 'FAILS'}</Chip> {c.question}</span>}
                meta={<span>{c.incident}{c.kind ? ` · ${c.kind}` : ''} · {(c.ms / 1000).toFixed(1)} s{c.failures.length ? ` — ${c.failures.join(' · ')}` : ''}{c.said ? ` — said: “${c.said.slice(0, 140)}${c.said.length > 140 ? '…' : ''}”` : ''}</span>} />
            ))}
          </List>
        </Section>
      )}
      <Section title="The live gates, by night" count={nightly.gates.length} aside={<Meta>{nightly.reports.map((r) => `${String(r.at).slice(0, 10)}: ${r.passed}/${r.total}`).join(' · ')}</Meta>} testId="evals-gates">
        {nightly.gates.length === 0 ? <Empty title="No nightly report yet">Run <Mono>pnpm check:live-gates</Mono> and <Mono>npx tsx scripts/build-evals-dashboard.mts</Mono>.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-sm)' }}>
              <thead><tr><th style={{ textAlign: 'left', padding: '4px 8px' }}>gate</th><th style={{ textAlign: 'left', padding: '4px 8px' }}>spec</th>{nightly.nights.map((n) => <th key={n} style={{ textAlign: 'left', padding: '4px 8px' }}>{n.slice(5)}</th>)}</tr></thead>
              <tbody>
                {nightly.gates.map((g) => (
                  <tr key={g.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '4px 8px' }}><Mono>{g.id}</Mono>{!g.required && <Meta> · advisory</Meta>}</td>
                    <td style={{ padding: '4px 8px' }}><Meta>{g.spec}</Meta></td>
                    {nightly.nights.map((n) => { const c = g.nights[n]; return <td key={n} style={{ padding: '4px 8px' }}>{c ? <Chip tone={tone(c.status)} title={`${c.status} · ${(c.ms / 1000).toFixed(0)} s`}>{c.cls ?? c.status}</Chip> : <Meta>—</Meta>}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="The failure classes" count={nightly.classes.length}>
        <KeyValue rows={nightly.classes.map((c) => [<Mono key={c.id}>{c.id}</Mono>, c.why])} />
      </Section>
      <Note>Folded at {new Date(D.builtAt).toLocaleString()} from <Mono>live-gates-reports/</Mono>. A gate&rsquo;s class is read off its own last lines by a fixed table — never a model. <Mono>unclassified</Mono> is itself a finding: a failure shape the table does not know yet.</Note>
    </>
  );
}
