'use client';
// THE LAB — spec 415 §5b: what was tested, whether each intent got the right skill, how each skill fares, what the
// harness did, and what to change. Renders the skill assessment report (`ap eval report`, baked at build time by
// `scripts/build-evals-dashboard.mts`) — it judges nothing and derives no number. The sentences shown are the replay
// sets' AUTHORED test intents; a person's words never reach the eval store (spec 414 §8).
import { useMemo, useState } from 'react';
import report from '../../evals/skill-assessment.json';
import { Section, List, Row, Chip, Stats, Stat, Tabs, FilterChip, Note, Card } from '../../ui';
import { whitelabel } from '../../whitelabel/config';

type Outcome = 'tp' | 'tp-alt' | 'tn' | 'mis-sib' | 'mis-far' | 'miss' | 'spur' | 'undetected';
interface IntentRow { intentId: string; message: string; split: string; bucket?: string; expected: string | null; chosen: string | null; outcome: Outcome; label: string; ok: boolean | null; why?: string; ms?: number; contaminated?: { skill: string; overlap: number; isNot: boolean } }
interface PerSkill { skill: string; asked: number; right: number; accuracy: number | null; ci: [number, number] | null; wronglyChosen: number; confusedWith: Array<{ skill: string; times: number }> }
interface Variant { name: string; how: string; runs: number; macroTa: number | null; macroCi: [number, number] | null; microTa: number | null; holdRate: number | null; holdNum?: number; holdDen?: number; routingPurity: number | null; right: number; wrong: number; declinedCorrectly: number; firedWrongly: number; gate: { status: string; reason: string } | null; intents: IntentRow[]; perSkill: PerSkill[] }
interface Experiment { id: string; slate: string; split: string; repeats: number; startedAt: string; finishedAt: string; variants: Variant[]; comparisons: Array<{ a: string; b: string; changed: string[]; confounded: boolean; words: string }> }
interface Recommendation { rule: string; severity: 'act' | 'watch' | 'info'; title: string; detail: string; change: string; skill?: string; experiment: string; variant?: string; evidence: { intents: string[]; numbers: Record<string, number | string> } }
interface Report { builtAt: string; experiments: Experiment[]; skillContracts: Array<{ skill: string; slates: Array<{ experiment: string; variant: string; asked: number; right: number; accuracy: number | null; wronglyChosen: number; confusedWith: Array<{ skill: string; times: number }> }>; recommendations: number }>; recommendations: Recommendation[]; headline: string[]; glossary: { outcomes: Record<Outcome, { label: string; ok: boolean | null; explain: string }>; approaches: Record<string, string> } }

const R = report as unknown as Report;
/** The skills library (skill-web), where each playbook skill's own Assessment card lives — the deployment's footer link
 *  (white-label config), never a literal here. Absent ⇒ no outbound link is drawn. */
const SKILLS_WEB = whitelabel.footer.links.find((l) => /skills library/i.test(l.label))?.href.replace(/\/$/, '') ?? null;
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const skillName = (s: string | null | undefined): string => (s ? s.replace(/^skill:/, '').replace(/^[^/]+\//, '') : 'no skill');
const slateName = (e: Experiment): string => `${e.slate.replace(/^cil-commons-routing-/, '').replace(/@\d+$/, '')} · ${e.split}`;
const outcomeTone = (o: IntentRow): 'ok' | 'warn' | 'danger' | undefined => (o.ok === true ? 'ok' : o.ok === false ? 'danger' : 'warn');
const SEVERITY: Record<Recommendation['severity'], { label: string; tone?: 'ok' | 'warn' | 'danger' }> = { act: { label: 'act on this', tone: 'danger' }, watch: { label: 'watch', tone: 'warn' }, info: { label: 'good to know' } };

export function SkillAssessmentLab() {
  const latest = useMemo(() => {
    const m = new Map<string, Experiment>();
    for (const e of R.experiments) m.set(`${e.slate}|${e.split}`, e);
    return [...m.values()];
  }, []);
  const [expId, setExpId] = useState<string>(latest[latest.length - 1]?.id ?? R.experiments[0]?.id ?? '');
  const exp = R.experiments.find((e) => e.id === expId);
  const [variantName, setVariantName] = useState<string>(exp?.variants[0]?.name ?? '');
  const variant = exp?.variants.find((v) => v.name === variantName) ?? exp?.variants[0];
  const [onlyWrong, setOnlyWrong] = useState(false);
  const [skillFilter, setSkillFilter] = useState<string | null>(null);
  const [openIntent, setOpenIntent] = useState<string | null>(null);
  const [recFilter, setRecFilter] = useState<'act' | 'all'>('act');

  if (!R.experiments.length) return <Note>No skill assessment has been run yet. Run <code>ap eval compare</code>, then <code>ap eval report</code>.</Note>;
  const allRuns = R.experiments.reduce((n, e) => n + e.variants.reduce((m, v) => m + v.runs, 0), 0);
  const intents = (variant?.intents ?? []).filter((i) => (!onlyWrong || i.ok === false) && (!skillFilter || i.expected === skillFilter || i.chosen === skillFilter));
  const recs = R.recommendations.filter((r) => recFilter === 'all' || r.severity === 'act');

  return (
    <div data-testid="skill-assessment-lab">
      <Card quiet>
        <p style={{ margin: 0 }}>
          <strong>What this tests.</strong> Each test is a sentence a person might say to an agent that holds the skills. For every sentence the
          test set says which skill <em>should</em> handle it — or that <em>none</em> should. The sentence is sent to the sandbox organization&apos;s agent,
          the harness records which skill it actually used, and the two are compared. Nothing here grades the answer&apos;s quality — only whether the
          right skill was chosen, and whether the agent declined when no skill fits.
        </p>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }} data-testid="lab-headline">
          {R.headline.map((h) => <li key={h}>{h}</li>)}
        </ul>
      </Card>

      <Stats>
        <Stat label="Experiments" value={R.experiments.length} hint={`${allRuns} runs in all`} />
        <Stat label="Right skill (latest)" value={pct(ratio(latest, (v) => v.right, (v) => v.intents.filter((i) => i.expected).length))} tone="ok" hint="when a skill should handle the ask" />
        <Stat label="Declined when it should" value={pct(ratio(latest, (v) => v.holdNum ?? 0, (v) => v.holdDen ?? 0))} tone={(ratio(latest, (v) => v.holdNum ?? 0, (v) => v.holdDen ?? 0) ?? 1) < 0.95 ? 'warn' : 'ok'} hint="when no skill fits (target 95%)" />
        <Stat label="To act on" value={R.recommendations.filter((r) => r.severity === 'act').length} tone={R.recommendations.some((r) => r.severity === 'act') ? 'danger' : undefined} hint="recommendations below" />
      </Stats>

      <Section title="What to change" count={recs.length} testId="lab-recommendations"
        aside={<span style={{ display: 'flex', gap: 6 }}><FilterChip active={recFilter === 'act'} onClick={() => setRecFilter('act')}>Act on</FilterChip><FilterChip active={recFilter === 'all'} onClick={() => setRecFilter('all')}>All</FilterChip></span>}>
        <Note>Each recommendation comes from a declared rule over the results and names the test sentences it rests on. Recommendations come from the latest experiment on each test set.</Note>
        <List>
          {recs.map((r, i) => (
            <Row key={`${r.rule}:${i}`} testId="lab-recommendation" title={r.title}
              meta={<>
                <div>{r.detail}</div>
                <div style={{ marginTop: 2 }}><strong>Change:</strong> {r.change}</div>
                <div style={{ opacity: 0.7, marginTop: 2 }}>{r.rule} · {r.experiment}{r.variant ? ` · ${r.variant}` : ''}{r.evidence.intents.length ? ` · ${r.evidence.intents.length} test sentence${r.evidence.intents.length === 1 ? '' : 's'}` : ''}</div>
              </>}
              side={<>
                <Chip tone={SEVERITY[r.severity].tone}>{SEVERITY[r.severity].label}</Chip>
                {r.skill && <button type="button" className="btn ghost" onClick={() => { setSkillFilter(r.skill!); setExpId(r.experiment); if (r.variant) setVariantName(r.variant); }}>show</button>}
              </>} />
          ))}
        </List>
      </Section>

      <Section title="Experiments" count={R.experiments.length} testId="lab-experiments">
        <Tabs label="experiment" value={expId} onChange={(id) => { setExpId(id); setVariantName(R.experiments.find((e) => e.id === id)?.variants[0]?.name ?? ''); setSkillFilter(null); }}
          items={R.experiments.map((e) => ({ id: e.id, label: `${slateName(e)} · ${new Date(e.startedAt).toLocaleDateString()}${latest.includes(e) ? '' : ' (earlier)'}` }))} />
        {exp && (
          <>
            <p className="ui-micro" style={{ margin: '6px 0' }}>{exp.id} · {exp.variants.reduce((n, v) => n + v.runs, 0)} runs · {exp.repeats} repeat{exp.repeats === 1 ? '' : 's'} · {new Date(exp.startedAt).toLocaleString()}</p>
            {exp.variants.length > 1 && <Tabs label="approach" value={variant?.name ?? ''} onChange={setVariantName} items={exp.variants.map((v) => ({ id: v.name, label: v.name }))} />}
            {variant && (
              <div data-testid="lab-variant">
                <Note><strong>How this approach selects:</strong> {variant.how}.</Note>
                <Stats>
                  <Stat label="Right skill" value={`${variant.right}/${variant.intents.filter((i) => i.expected).length}`} tone="ok" />
                  <Stat label="Declined when it should" value={variant.holdDen ? `${variant.holdNum}/${variant.holdDen}` : '—'} tone={variant.holdRate !== null && variant.holdRate < 0.95 ? 'warn' : undefined} hint={variant.holdDen ? undefined : 'this test set has no out-of-scope asks'} />
                  <Stat label="Accuracy across skills" value={pct(variant.macroTa)} hint={variant.macroCi ? `95% interval ${pct(variant.macroCi[0])}–${pct(variant.macroCi[1])}` : undefined} />
                  <Stat label="Gate" value={variant.gate?.status ?? '—'} tone={variant.gate?.status === 'PASS' ? 'ok' : variant.gate?.status === 'FAIL' ? 'danger' : 'warn'} hint={variant.gate?.reason} />
                </Stats>
                {exp.comparisons.map((c) => <Note key={`${c.a}:${c.b}`}><strong>Compared:</strong> {c.words}.</Note>)}

                <div className="ui-toolbar" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <FilterChip active={!onlyWrong} onClick={() => setOnlyWrong(false)} count={variant.intents.length}>Every test</FilterChip>
                  <FilterChip active={onlyWrong} onClick={() => setOnlyWrong(true)} count={variant.wrong} data-testid="lab-only-wrong">Only wrong</FilterChip>
                  {skillFilter && <FilterChip active onClick={() => setSkillFilter(null)}>{skillName(skillFilter)} ✕</FilterChip>}
                </div>
                <List testId="lab-intents">
                  {intents.map((i) => (
                    <Row key={i.intentId} testId="lab-intent" dataState={i.ok === true ? 'ok' : i.ok === false ? 'wrong' : 'neutral'}
                      title={`“${i.message}”`}
                      meta={<>
                        <span>should be <strong>{skillName(i.expected)}</strong> · chose <strong>{skillName(i.chosen)}</strong></span>
                        <span style={{ opacity: 0.65 }}> · {i.intentId}{i.bucket ? ` · ${i.bucket}` : ''}{i.ms ? ` · ${(i.ms / 1000).toFixed(0)}s` : ''}</span>
                        {openIntent === i.intentId && (
                          <div style={{ marginTop: 4 }}>
                            <div>{R.glossary.outcomes[i.outcome]?.explain}.</div>
                            {i.why && <div style={{ opacity: 0.8 }}>Why the test set says so: {i.why}</div>}
                            {i.contaminated && <div style={{ color: 'var(--color-amber-700, #b45309)' }}>This sentence is {Math.round(i.contaminated.overlap * 100)}% the same words as an example {skillName(i.contaminated.skill)} declares{i.contaminated.isNot ? ' as not its job' : ''} — the skill was shown the answer, so this result does not measure selection.</div>}
                          </div>
                        )}
                      </>}
                      side={<>
                        {i.contaminated && <Chip tone="warn" title={`${Math.round(i.contaminated.overlap * 100)}% of this sentence's words are in an example ${skillName(i.contaminated.skill)} declares${i.contaminated.isNot ? ' as NOT its job' : ''} — this result measures the example, not selection`}>test leaked into examples</Chip>}
                        <Chip tone={outcomeTone(i)} title={R.glossary.outcomes[i.outcome]?.explain}>{i.label}</Chip>
                        <button type="button" className="btn ghost" onClick={() => setOpenIntent(openIntent === i.intentId ? null : i.intentId)}>{openIntent === i.intentId ? 'less' : 'why'}</button>
                      </>} />
                  ))}
                </List>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Each playbook skill" count={R.skillContracts.length} testId="lab-skills" aside={<span>latest result on each test set</span>}>
        <List>
          {R.skillContracts.map((s) => (
            <Row key={s.skill} testId="lab-skill" title={skillName(s.skill)}
              meta={<>
                {s.slates.map((x) => {
                  const e = R.experiments.find((y) => y.id === x.experiment);
                  return <div key={`${x.experiment}:${x.variant}`}>{e ? slateName(e) : x.experiment} · {x.variant}: {x.asked ? `${x.right}/${x.asked} right` : 'no positive tests'}{x.wronglyChosen ? ` · wrongly chosen ${x.wronglyChosen}×` : ''}{x.confusedWith.length ? ` · went to ${x.confusedWith.map((c) => `${skillName(c.skill)} (${c.times})`).join(', ')}` : ''}</div>;
                })}
              </>}
              side={<>
                {s.recommendations ? <Chip tone="warn">{s.recommendations} recommendation{s.recommendations === 1 ? '' : 's'}</Chip> : <Chip tone="ok">no open issue</Chip>}
                <button type="button" className="btn ghost" onClick={() => setSkillFilter(s.skill)}>tests</button>
                {SKILLS_WEB && <a className="btn ghost" href={`${SKILLS_WEB}/?skill=${encodeURIComponent(s.skill)}`} target="_blank" rel="noreferrer">in the skills library ↗</a>}
              </>} />
          ))}
        </List>
      </Section>

      <Section title="What the words mean">
        <List>
          {(Object.entries(R.glossary.outcomes) as Array<[Outcome, { label: string; ok: boolean | null; explain: string }]>).map(([k, w]) => (
            <Row key={k} title={w.label} meta={<>{w.explain}.</>} side={<Chip tone={w.ok === true ? 'ok' : w.ok === false ? 'danger' : 'warn'}>{w.ok === true ? 'counts as right' : w.ok === false ? 'counts as wrong' : 'not counted'}</Chip>} />
          ))}
        </List>
        <p className="ui-micro">Built {new Date(R.builtAt).toLocaleString()} from the eval store by <code>ap eval report</code>. Numbers only — the intents are the test set&apos;s authored sentences.</p>
      </Section>
    </div>
  );
}

/** Pooled over the latest experiment per test set (its `model` variant when it has one); null when nothing was measured. */
function ratio(list: readonly Experiment[], num: (v: Variant) => number, den: (v: Variant) => number): number | null {
  let n = 0, d = 0;
  for (const e of list) { const v = e.variants.find((x) => x.name === 'model') ?? e.variants[0]; if (!v) continue; n += num(v); d += den(v); }
  return d ? n / d : null;
}
