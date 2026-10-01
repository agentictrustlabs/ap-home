'use client';
// RUN A COMPARISON — spec 415 A5, the Lab's live half. A steward picks one of the organizations they steward, a replay
// set and its gold (the files the skills repo keeps under evaluations/<domain>/), the arms to compare — each one
// variant request: which provider SELECTS, which ANSWERS, which JUDGES, the judge's profile and mode — the split and the
// repeats, and submits. The deployment's experiment object runs it one case per alarm; this panel polls its progress and,
// when done, shows each arm's headline numbers and every pairwise comparison. The knobs are read from the deployment
// itself (`/harness/comparison`), never typed here; an estate that runs no comparisons disables the form.
//
// WHAT NEVER APPEARS: a case's words. Progress is counts by verdict and the newest runs by id; the record is numbers.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/session';
import { listManagedAgents } from '../../connect-client';
import { Section, Card, KeyValue, Button, Chip, Mono, ErrorNote, Note, Empty } from '../../ui';
import { StatePill } from './StatePill';
import { stateOf } from '../../home/run-state';
import { readComparisonKnobs, startExperiment, readExperiment, cancelExperiment, variantFromForm, type ComparisonKnobsV1, type ExperimentProgressV1 } from '../../home/experiments';

interface VariantRow { name: string; provider: string; selectionProvider: string; answerProvider: string; judgeProvider: string; judgeProfile: string; judge: string; selection: string }
const emptyRow = (name: string): VariantRow => ({ name, provider: '', selectionProvider: '', answerProvider: '', judgeProvider: '', judgeProfile: '', judge: 'outcome', selection: '' });
const JUDGE_PROFILES = ['', 'thorough', 'fast', 'logprob'];
const POLL_MS = 4000;
/** The experiment object's own words → the task states the ONE state vocabulary projects (spec 398 §5.1): a surface never
 *  renders a record's native state word. */
const TASK_STATE: Record<ExperimentProgressV1['status'], string> = { queued: 'submitted', running: 'working', done: 'completed', failed: 'failed', cancelled: 'canceled' };

async function readJsonFile(f: File | null): Promise<unknown> { if (!f) return undefined; return JSON.parse(await f.text()); }

export function ComparisonRunner() {
  const { session } = useSession();
  const token = session?.token ?? null;
  const [knobs, setKnobs] = useState<ComparisonKnobsV1 | null | 'loading'>('loading');
  const [orgs, setOrgs] = useState<Array<{ agent: string; name: string }>>([]);
  const [addressee, setAddressee] = useState('');
  const [setFile, setSetFile] = useState<File | null>(null);
  const [goldFile, setGoldFile] = useState<File | null>(null);
  const [fixturesFile, setFixturesFile] = useState<File | null>(null);
  const [rows, setRows] = useState<VariantRow[]>([emptyRow('control'), { ...emptyRow('treatment'), judgeProvider: '' }]);
  const [split, setSplit] = useState<'held-out' | 'development' | 'all'>('held-out');
  const [repeats, setRepeats] = useState(1);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExperimentProgressV1 | null>(null);

  useEffect(() => { void readComparisonKnobs().then(setKnobs); }, []);
  useEffect(() => {
    if (!token) return;
    void listManagedAgents(token, 'any').then((o) => setOrgs(o.filter((a) => a.relationship === 'steward' && a.kind !== 'service' && a.kind !== 'person-treasury' && a.kind !== 'org-treasury').map((a) => ({ agent: a.agent, name: a.name })))).catch(() => setOrgs([]));
  }, [token]);

  const canRun = !!token && knobs !== 'loading' && knobs !== null && knobs.evalCapture === 'on' && !!addressee && !!setFile && !!goldFile && rows.length > 0 && rows.every((r) => /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(r.name));

  const submit = useCallback(async () => {
    if (!token || !canRun) return;
    setBusy(true); setError(null);
    try {
      const [set, criterion, fixtures] = await Promise.all([readJsonFile(setFile), readJsonFile(goldFile), readJsonFile(fixturesFile)]);
      const variants = Object.fromEntries(rows.map((r) => [r.name, variantFromForm(r)]));
      const r = await startExperiment(token, { addressee, set, criterion, ...(fixtures ? { fixtures: (fixtures as { fixtures?: unknown }).fixtures ?? fixtures } : {}), variants, split, repeats, ...(planId.trim() ? { planId: planId.trim() } : {}) });
      if (!r.ok) { setError(r.error); return; }
      setProgress(r.progress);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [token, canRun, setFile, goldFile, fixturesFile, rows, addressee, split, repeats, planId]);

  // One case per alarm on the deployment: poll until the object says it is done, failed or cancelled.
  useEffect(() => {
    if (!token || !progress || !['queued', 'running'].includes(progress.status)) return;
    const t = setInterval(() => { void readExperiment(token, addressee, progress.planId).then((p) => { if (p) setProgress(p); }); }, POLL_MS);
    return () => clearInterval(t);
  }, [token, addressee, progress]);

  const providers = useMemo(() => (knobs && knobs !== 'loading' ? knobs.providers : []), [knobs]);
  const selections = useMemo(() => (knobs && knobs !== 'loading' ? knobs.selections : []), [knobs]);
  const judgeModes = useMemo(() => (knobs && knobs !== 'loading' ? [...(knobs.toggles['quality/judge'] ?? ['off', 'on', 'pairwise', 'outcome'])] : ['off', 'on', 'pairwise', 'outcome']), [knobs]);
  const setRow = (i: number, patch: Partial<VariantRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  if (!token) return <Empty title="Sign in to run a comparison" testId="comparison-runner-signin" />;
  if (knobs === 'loading') return <Card quiet testId="comparison-runner"><Note>Reading what this deployment can compare…</Note></Card>;
  if (!knobs) return <Card quiet testId="comparison-runner"><ErrorNote>This deployment did not answer <Mono>/harness/comparison</Mono>; comparisons cannot be started from here.</ErrorNote></Card>;
  if (knobs.evalCapture !== 'on') return <Card quiet testId="comparison-runner"><Note>This estate does not run comparisons (<Mono>EVAL_CAPTURE</Mono> is off). Comparisons run on a development estate.</Note></Card>;

  const sel = (value: string, onChange: (v: string) => void, options: string[], blank = '(deployment default)') => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 150 }}>
      <option value="">{blank}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div data-testid="comparison-runner">
      <Section title="Run a comparison" testId="comparison-runner-form">
        <Card quiet>
          <Note>One set, its gold, two or more arms. Each arm is one variant request: which provider selects the skill, which answers, which judges — and how. The deployment offers: <Mono>{providers.join(', ') || 'none'}</Mono>.</Note>
          <KeyValue rows={[
            ['Organization asked', orgs.length ? sel(addressee, setAddressee, orgs.map((o) => o.agent), '(choose an organization you steward)') : <span>No organization you steward is listed.</span>],
            ['Replay set (.replay.json)', <input key="set" type="file" accept="application/json,.json" onChange={(e) => setSetFile(e.target.files?.[0] ?? null)} />],
            ['Gold (.gold.json)', <input key="gold" type="file" accept="application/json,.json" onChange={(e) => setGoldFile(e.target.files?.[0] ?? null)} />],
            ['Fixtures (.fixtures.json, optional)', <input key="fx" type="file" accept="application/json,.json" onChange={(e) => setFixturesFile(e.target.files?.[0] ?? null)} />],
            ['Split', sel(split, (v) => setSplit((v || 'held-out') as 'held-out' | 'development' | 'all'), ['held-out', 'development', 'all'], 'held-out')],
            ['Repeats', <input key="rep" type="number" min={1} max={10} value={repeats} onChange={(e) => setRepeats(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} style={{ width: 64 }} />],
            ['Plan id (optional)', <input key="pid" type="text" value={planId} onChange={(e) => setPlanId(e.target.value)} placeholder="named after the set and the arms when blank" style={{ minWidth: 260 }} />],
          ]} />
        </Card>
        {orgs.length ? orgs.filter((o) => o.agent === addressee).map((o) => <Note key={o.agent}>Asking <Mono>{o.name}</Mono> ({o.agent.slice(0, 10)}…).</Note>) : null}
        <Card title="Arms" testId="comparison-runner-arms">
          <table className="ui-table" style={{ width: '100%' }}>
            <thead><tr><th>name</th><th>provider</th><th>selects with</th><th>answers with</th><th>judges with</th><th>judge profile</th><th>judge mode</th><th>selection arm</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} data-testid="comparison-runner-arm">
                  <td><input type="text" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} style={{ width: 110 }} /></td>
                  <td>{sel(r.provider, (v) => setRow(i, { provider: v }), providers)}</td>
                  <td>{sel(r.selectionProvider, (v) => setRow(i, { selectionProvider: v }), providers, '(as provider)')}</td>
                  <td>{sel(r.answerProvider, (v) => setRow(i, { answerProvider: v }), providers, '(as provider)')}</td>
                  <td>{sel(r.judgeProvider, (v) => setRow(i, { judgeProvider: v }), providers, '(as provider)')}</td>
                  <td>{sel(r.judgeProfile, (v) => setRow(i, { judgeProfile: v }), JUDGE_PROFILES.filter(Boolean), '(thorough)')}</td>
                  <td>{sel(r.judge, (v) => setRow(i, { judge: v || 'off' }), judgeModes, 'off')}</td>
                  <td>{sel(r.selection, (v) => setRow(i, { selection: v }), selections, '(model)')}</td>
                  <td>{rows.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>remove</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={() => setRows((rs) => [...rs, emptyRow(`arm-${rs.length + 1}`)])}>+ arm</Button>
            <Button variant="primary" disabled={!canRun || busy} onClick={() => void submit()} data-testid="comparison-runner-submit">{busy ? 'Submitting…' : 'Run'}</Button>
          </div>
          <Note>A blank choice is the deployment's default; an arm with every choice blank is the live arm. Two arms that differ in more than one choice compare as confounded — said in the record, never hidden.</Note>
        </Card>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </Section>
      {progress ? <ExperimentProgress progress={progress} onCancel={token ? async () => { const p = await cancelExperiment(token, addressee, progress.planId); if (p) setProgress(p); } : undefined} /> : null}
    </div>
  );
}

/** Progress and, when done, the scores — numbers and ids only. Exported so a test can render it without a session. */
export function ExperimentProgress({ progress, onCancel }: { progress: ExperimentProgressV1; onCancel?: () => Promise<void> }) {
  const live = progress.status === 'queued' || progress.status === 'running';
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Section title={<span>Experiment <Mono>{progress.planId}</Mono></span>} testId="comparison-runner-progress" aside={<StatePill state={stateOf({ kind: 'task', state: TASK_STATE[progress.status] })} native={progress.status} compact />}>
      <Card quiet>
        <KeyValue rows={[
          ['Cases', <span key="c">{progress.done} of {progress.total} ({pct}%){progress.failed ? `, ${progress.failed} failed` : ''}</span>],
          ['By verdict', <span key="v">{Object.entries(progress.byOutcome).sort().map(([k, n]) => <Chip key={k} tone={k === 'tp' || k === 'tn' ? 'ok' : k === 'failed' || k === 'unreadable' ? 'danger' : 'warn'}>{k} {n}</Chip>)}</span>],
          ...(progress.startedAt ? [['Started', progress.startedAt] as [string, string]] : []),
          ...(progress.finishedAt ? [['Finished', progress.finishedAt] as [string, string]] : []),
          ...(progress.error ? [['Error', progress.error] as [string, string]] : []),
        ]} />
        {live && onCancel ? <Button size="sm" variant="ghost" onClick={() => void onCancel()}>Cancel</Button> : null}
      </Card>
      {progress.recent.length ? (
        <Card title="Newest runs" quiet>
          <table className="ui-table" style={{ width: '100%' }}>
            <thead><tr><th>case</th><th>arm</th><th>repeat</th><th>verdict</th><th>chosen</th><th>ms</th></tr></thead>
            <tbody>{progress.recent.map((r) => <tr key={`${r.intentId}-${r.variant}-${r.repeat}`}><td><Mono>{r.intentId}</Mono></td><td>{r.variant}</td><td>{r.repeat}</td><td>{r.outcome ?? r.status}</td><td>{r.selected.map((s) => s.split('/').pop()).join(', ') || '—'}</td><td>{r.ms}</td></tr>)}</tbody>
          </table>
        </Card>
      ) : null}
      {progress.scores ? (
        <Card title="Scores" testId="comparison-runner-scores">
          <table className="ui-table" style={{ width: '100%' }}>
            <thead><tr><th>arm</th><th>micro TA</th><th>macro TA</th><th>hold</th><th>purity</th><th>gate</th></tr></thead>
            <tbody>{Object.entries(progress.scores).map(([arm, s]) => {
              const f = (k: string) => { const v = s[k]; return v && typeof v.value === 'number' ? v.value.toFixed(3) + (v.num !== undefined && v.den ? ` (${v.num}/${v.den})` : '') : '—'; };
              const v = progress.verdicts?.[arm];
              return <tr key={arm}><td>{arm}</td><td>{f('micro_ta')}</td><td>{f('macro_ta')}</td><td>{f('hold_rate')}</td><td>{f('routing_purity')}</td><td>{v ? <Chip tone={v.status === 'PASS' ? 'ok' : v.status === 'FAIL' ? 'danger' : 'warn'} title={v.reason}>{v.status}</Chip> : '—'}</td></tr>;
            })}</tbody>
          </table>
          {progress.comparisons?.length ? (
            <table className="ui-table" style={{ width: '100%', marginTop: 8 }}>
              <thead><tr><th>pair</th><th>what differs</th><th>Δ macro</th><th>fixed / broken</th><th>p</th></tr></thead>
              <tbody>{progress.comparisons.map((c) => <tr key={`${c.a}→${c.b}`}><td>{c.a} → {c.b}</td><td>{c.confounded ? <Chip tone="warn">confounded: {c.confounds.join(', ')}</Chip> : (c.confounds.join(', ') || 'nothing')}</td><td>{c.delta_macro !== undefined ? c.delta_macro.toFixed(3) : (c.error ?? '—')}</td><td>{c.fixed !== undefined ? `${c.fixed} / ${c.broken}` : '—'}</td><td>{c.p_value !== undefined ? c.p_value.toFixed(3) : '—'}</td></tr>)}</tbody>
            </table>
          ) : null}
          {progress.refused?.length ? <Note>Capture refused: {progress.refused.join(' · ')} — the verdicts stand; the traces were not exported.</Note> : null}
        </Card>
      ) : null}
    </Section>
  );
}
