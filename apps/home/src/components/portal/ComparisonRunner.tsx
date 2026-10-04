'use client';
// RUN A COMPARISON — spec 415 A5, the Lab's live half. A steward picks one of the organizations they steward, a replay
// set and its gold (the files the skills repo keeps under evaluations/<domain>/), the arms to compare — each one
// variant request: which provider SELECTS, which ANSWERS, which JUDGES, the judge's profile and mode — the split and the
// repeats, and submits. The deployment's experiment object runs it one case per alarm; this panel polls its progress and,
// when done, shows each arm's headline numbers and every pairwise comparison. The knobs are read from the deployment
// itself (`/harness/comparison`), never typed here; an estate that runs no comparisons disables the form.
//
// WHAT NEVER APPEARS: a case's words. Progress is counts by verdict and the newest runs by id; the record is numbers.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../context/session';
import { listManagedAgents } from '../../connect-client';
import { Section, Card, KeyValue, Button, Chip, Mono, ErrorNote, Note, Empty } from '../../ui';
import { StatePill } from './StatePill';
import { stateOf } from '../../home/run-state';
import { readComparisonKnobs, startExperiment, readExperiment, cancelExperiment, variantFromForm, prefillFromQuery, ARM_NAME, type ComparisonKnobsV1, type ExperimentProgressV1 } from '../../home/experiments';
import { applyWords, armWords, defaultDraft, emptyArm, readyWords, type ArmRow, type ComparisonDraft, type EvalSetSummary } from '../../home/comparison-defaults';

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
  const [sets, setSets] = useState<EvalSetSummary[]>([]);
  const [orgs, setOrgs] = useState<Array<{ agent: string; name: string }>>([]);
  const [addressee, setAddressee] = useState('');
  // THE DRAFT (owner, 2026-10-01): everything has a default a person can run as-is — set once the deployment's knobs and
  // the baked sets are known; every control below edits it. `touched` keeps a person's own change from being overwritten.
  const [draft, setDraft] = useState<ComparisonDraft | null>(null);
  const [source, setSource] = useState<'named' | 'upload'>('named');
  const [setFile, setSetFile] = useState<File | null>(null);
  const [goldFile, setGoldFile] = useState<File | null>(null);
  const [fixturesFile, setFixturesFile] = useState<File | null>(null);
  const [words, setWords] = useState('');
  const [heard, setHeard] = useState<{ understood: string[]; ignored: string[] } | null>(null);
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExperimentProgressV1 | null>(null);

  useEffect(() => { void readComparisonKnobs().then(setKnobs); }, []);
  useEffect(() => { void fetch('/connect/eval-sets').then((r) => r.json()).then((m: { sets?: EvalSetSummary[] }) => setSets(m.sets ?? [])).catch(() => setError('the eval sets could not be read — none are listed because of that, not because there are none')); }, []);
  useEffect(() => {
    if (!token) return;
    void listManagedAgents(token, 'any').then((o) => { const mine = o.filter((a) => a.relationship === 'steward' && a.kind !== 'service' && a.kind !== 'person-treasury' && a.kind !== 'org-treasury').map((a) => ({ agent: a.agent, name: a.name })); setOrgs(mine); setAddressee((cur) => cur || mine[0]?.agent || ''); });
  }, [token]);
  useEffect(() => { if (knobs && knobs !== 'loading' && !draft) setDraft(defaultDraft(knobs, sets)); }, [knobs, sets, draft]);
  // The recommended set arrives after the knobs sometimes: fill an empty set id once, never overwrite a chosen one.
  useEffect(() => { if (draft && !draft.setId && sets.length) setDraft({ ...draft, setId: defaultDraft({ providers: [], selections: [] }, sets).setId }); }, [sets, draft]);
  // A deep link (`?agent=&set=&repeats=&arms=`, e.g. from the skills app's Tests page) preselects once the lists it names
  // have arrived; the arms are checked against this deployment's knobs and land as the person's own rows, editable.
  const [prefilled, setPrefilled] = useState<{ agent: boolean; set: boolean; run: boolean }>({ agent: false, set: false, run: false });
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const k = knobs && knobs !== 'loading' ? knobs : null;
    const want = prefillFromQuery(window.location.search, orgs, sets, k);
    if (!prefilled.agent && want.addressee && orgs.length) { setAddressee(want.addressee); setPrefilled((p) => ({ ...p, agent: true })); }
    if (!prefilled.set && want.setId && sets.length && draft) { setDraft({ ...draft, setId: want.setId }); setSource('named'); setPrefilled((p) => ({ ...p, set: true })); }
    if (!prefilled.run && k && draft) {
      if (want.rows || want.repeats) setDraft((d) => (d ? { ...d, ...(want.rows ? { rows: want.rows } : {}), ...(want.repeats ? { repeats: want.repeats } : {}) } : d));
      if (want.notice) setPrefillNotice(want.notice);
      setPrefilled((p) => ({ ...p, run: true }));
    }
  }, [orgs, sets, draft, prefilled, knobs]);

  const rows = draft?.rows ?? [];
  const split = draft?.split ?? 'held-out';
  const repeats = draft?.repeats ?? 1;
  const patch = (p: Partial<ComparisonDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const setRow = (i: number, patchRow: Partial<ArmRow>) => patch({ rows: rows.map((r, k) => (k === i ? { ...r, ...patchRow } : r)) });
  const setRows = (f: (rs: ArmRow[]) => ArmRow[]) => patch({ rows: f(rows) });
  const chosenSet = sets.find((x) => x.id === draft?.setId) ?? null;
  const haveSet = source === 'named' ? !!chosenSet : !!setFile && !!goldFile;
  const canRun = !!token && knobs !== 'loading' && knobs !== null && knobs.evalCapture === 'on' && !!addressee && haveSet && rows.length > 0 && rows.every((r) => ARM_NAME.test(r.name));

  const submit = useCallback(async () => {
    if (!token || !canRun || !draft) return;
    setBusy(true); setError(null);
    try {
      let set: unknown, criterion: unknown, fixtures: unknown;
      if (source === 'named') {
        const r = await fetch(`/connect/eval-sets/${encodeURIComponent(draft.setId)}`);
        const b = (await r.json()) as { replay?: unknown; gold?: unknown; fixtures?: unknown; error?: string };
        if (!r.ok || !b.replay || !b.gold) throw new Error(b.error ?? 'the test set could not be read');
        set = b.replay; criterion = b.gold; fixtures = b.fixtures;
      } else {
        [set, criterion, fixtures] = await Promise.all([readJsonFile(setFile), readJsonFile(goldFile), readJsonFile(fixturesFile)]);
        if (fixtures && typeof fixtures === 'object' && 'fixtures' in (fixtures as object)) fixtures = (fixtures as { fixtures: unknown }).fixtures;
      }
      const variants = Object.fromEntries(rows.map((r) => [r.name, variantFromForm(r)]));
      const r = await startExperiment(token, { addressee, set, criterion, ...(fixtures ? { fixtures } : {}), variants, split, repeats, ...(planId.trim() ? { planId: planId.trim() } : {}) });
      if (!r.ok) { setError(r.error); return; }
      setProgress(r.progress);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [token, canRun, draft, source, setFile, goldFile, fixturesFile, rows, addressee, split, repeats, planId]);

  // One case per alarm on the deployment: poll until the object says it is done, failed or cancelled.
  useEffect(() => {
    if (!token || !progress || !['queued', 'running'].includes(progress.status)) return;
    const t = setInterval(() => { void readExperiment(token, addressee, progress.planId).then((p) => { if (p) setProgress(p); }); }, POLL_MS);
    return () => clearInterval(t);
  }, [token, addressee, progress]);

  const providers = useMemo(() => (knobs && knobs !== 'loading' ? knobs.providers : []), [knobs]);
  const selections = useMemo(() => (knobs && knobs !== 'loading' ? knobs.selections : []), [knobs]);
  const judgeModes = useMemo(() => (knobs && knobs !== 'loading' ? [...(knobs.toggles['quality/judge'] ?? ['off', 'on', 'pairwise', 'outcome'])] : ['off', 'on', 'pairwise', 'outcome']), [knobs]);

  if (!token) return <Empty title="Sign in to run a comparison" testId="comparison-runner-signin" />;
  if (knobs === 'loading' || !draft) return <Card quiet testId="comparison-runner"><Note>Reading what this deployment can compare…</Note></Card>;
  if (!knobs) return <Card quiet testId="comparison-runner"><ErrorNote>This deployment did not answer <Mono>/harness/comparison</Mono>; comparisons cannot be started from here.</ErrorNote></Card>;
  if (knobs.evalCapture !== 'on') return <Card quiet testId="comparison-runner"><Note>This estate does not run comparisons (<Mono>EVAL_CAPTURE</Mono> is off). Comparisons run on a development estate.</Note></Card>;

  const hear = () => {
    if (!words.trim()) return;
    const r = applyWords(words, knobs, sets, draft);
    setDraft(r.draft);
    setHeard({ understood: r.understood, ignored: r.ignored });
  };
  const resetDefaults = () => { setDraft(defaultDraft(knobs, sets)); setSource('named'); setWords(''); setHeard(null); };
  const orgName = orgs.find((o) => o.agent === addressee)?.name ?? null;

  const sel = (value: string, onChange: (v: string) => void, options: string[], blank = '(deployment default)') => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 150 }}>
      <option value="">{blank}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div data-testid="comparison-runner">
      <Section title="Run a comparison" testId="comparison-runner-form">
        {/* 1. Ready as it is: one line saying what will run if nothing is changed, and the one button. */}
        <Card testId="comparison-runner-ready">
          <p style={{ margin: '0 0 6px' }}><strong>Ready to run:</strong> {readyWords(draft, orgName, sets)}</p>
          <p className="ui-micro" style={{ margin: '0 0 8px' }}>These are the defaults. Press Run as they are, or change anything below — in words or with the controls.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="primary" disabled={!canRun || busy} onClick={() => void submit()} data-testid="comparison-runner-submit">{busy ? 'Submitting…' : 'Run'}</Button>
            <Button size="sm" variant="ghost" onClick={resetDefaults}>Back to the defaults</Button>
          </div>
        </Card>
        {prefillNotice ? <Note>{prefillNotice}</Note> : null}
        {/* 2. In words: a deterministic reading over what this deployment offers; it says back what it understood. */}
        <Card title="Tell me what to compare" quiet testId="comparison-runner-words">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input type="text" value={words} onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') hear(); }} placeholder={`e.g. "compare ${providers[0] ?? 'gemini'} and ${providers[1] ?? providers[0] ?? 'groq'}, outcome judge, 3 repeats, all cases"`} style={{ flex: '1 1 320px' }} data-testid="comparison-runner-words-input" />
            <Button size="sm" onClick={hear}>Apply</Button>
          </div>
          <p className="ui-micro" style={{ margin: '6px 0 0' }}>It knows: the providers this deployment offers ({providers.join(', ') || 'none'}), judge modes ({judgeModes.join(', ')}), {selections.some((x) => /rule/i.test(x)) ? '"rules" for the rule-based selector, ' : ''}"N repeats", "all cases" / "held-out", and a set by its name. Anything it does not say back stays as it is.</p>
          {heard && (
            <Note>
              {heard.understood.length ? <><strong>Understood:</strong> {heard.understood.join(' · ')}.</> : <strong>Nothing in that sentence matched a knob.</strong>}
              {heard.ignored.length ? <> <strong>Not offered here:</strong> {heard.ignored.join(', ')}.</> : null}
            </Note>
          )}
        </Card>
        {/* 3. The controls, each starting at its default. */}
        <Card quiet>
          <KeyValue rows={[
            ['Organization asked', orgs.length ? (
              <select key="org" value={addressee} onChange={(e) => setAddressee(e.target.value)} style={{ minWidth: 220 }} data-testid="comparison-runner-org">
                <option value="">(choose an organization you steward)</option>
                {orgs.map((o) => <option key={o.agent} value={o.agent}>{o.name || `${o.agent.slice(0, 8)}…${o.agent.slice(-4)}`}</option>)}
              </select>
            ) : <span>No organization you steward is listed.</span>],
            ['Test set', <span key="set" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={source === 'named' ? draft.setId : '__upload'} onChange={(e) => { if (e.target.value === '__upload') setSource('upload'); else { setSource('named'); patch({ setId: e.target.value }); } }} data-testid="comparison-runner-set">
                {sets.map((x) => <option key={x.id} value={x.id}>{x.title} · {x.cases} cases{x.recommended ? ' · recommended' : ''}</option>)}
                <option value="__upload">Upload my own…</option>
              </select>
              {chosenSet && source === 'named' ? <span className="ui-micro">{chosenSet.domain} · {chosenSet.fixtures ? 'with fixtures' : 'no fixtures'}</span> : null}
            </span>],
            ...(source === 'upload' ? [
              ['Replay set (.replay.json)', <input key="set" type="file" accept="application/json,.json" onChange={(e) => setSetFile(e.target.files?.[0] ?? null)} />] as [string, React.ReactNode],
              ['Gold (.gold.json)', <input key="gold" type="file" accept="application/json,.json" onChange={(e) => setGoldFile(e.target.files?.[0] ?? null)} />] as [string, React.ReactNode],
              ['Fixtures (.fixtures.json, optional)', <input key="fx" type="file" accept="application/json,.json" onChange={(e) => setFixturesFile(e.target.files?.[0] ?? null)} />] as [string, React.ReactNode],
            ] : []),
            ['Split', sel(split, (v) => patch({ split: (v || 'held-out') as ComparisonDraft['split'] }), ['held-out', 'development', 'all'], 'held-out')],
            ['Repeats', <input key="rep" type="number" min={1} max={10} value={repeats} onChange={(e) => patch({ repeats: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} style={{ width: 64 }} />],
            ['Plan id (optional)', <input key="pid" type="text" value={planId} onChange={(e) => setPlanId(e.target.value)} placeholder="named after the set and the arms when blank" style={{ minWidth: 260 }} />],
          ]} />
        </Card>
        {orgs.length ? orgs.filter((o) => o.agent === addressee).map((o) => <Note key={o.agent}>Asking <strong>{o.name}</strong> — its agent is <Mono>{o.agent.slice(0, 10)}…</Mono>.</Note>) : null}
        <Card title="Arms" testId="comparison-runner-arms">
          <p className="ui-micro" style={{ margin: '0 0 6px' }}>Each arm is one way of running the same cases. <strong>control</strong> is the live default; <strong>treatment</strong> starts one change away ({armWords(rows[1] ?? rows[0]!, rows[0]!) || 'no change yet'}). A blank choice means the deployment's default.</p>
          <table className="ui-table" style={{ width: '100%' }}>
            <thead><tr><th>name</th><th>provider</th><th>selects with</th><th>answers with</th><th>judges with</th><th>judge profile</th><th>judge mode</th><th>selection arm</th><th>other toggles</th><th /></tr></thead>
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
                  <td>{r.toggles && Object.keys(r.toggles).length ? <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{Object.entries(r.toggles).map(([k, v]) => <Chip key={k} title="from the link; remove to run the deployment default">{k}={v} <button type="button" aria-label={`remove ${k}`} onClick={() => setRow(i, { toggles: Object.fromEntries(Object.entries(r.toggles ?? {}).filter(([x]) => x !== k)) })} style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }}>×</button></Chip>)}</span> : <span className="ui-micro">—</span>}</td>
                  <td>{rows.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>remove</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={() => setRows((rs) => [...rs, emptyArm(`arm-${rs.length + 1}`)])}>+ arm</Button>
            <Button variant="primary" disabled={!canRun || busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Run'}</Button>
          </div>
          <Note>Two arms that differ in more than one choice compare as confounded — said in the record, never hidden.</Note>
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
