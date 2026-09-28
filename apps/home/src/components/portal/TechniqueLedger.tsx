'use client';
// THE TECHNIQUE LEDGER — spec 418 §4. Every technique tried on the playbooks' evaluation sets, measured the same way: a
// paired comparison inside one experiment (baseline → treatment) — quality by McNemar over the same cases, cost by the
// paired median change in tokens and time — and a verdict by a declared rule. Planned techniques show the A/B that will
// measure them. Baked at build time from `ap eval ledger`; the screen renders, it judges nothing.
import { useState } from 'react';
import ledger from '../../evals/technique-ledger.json';

interface Cost { base: number | null; treat: number | null; delta: number | null; deltaPct: number | null; ci?: [number, number] }
interface Comparison { experiment: string; baseline: string; treatment: string; n: number; finishedAt?: string;
  quality: { metric: string; base: number; treat: number; delta: number; fixed: number; broken: number; p: number };
  cost: { pickTokens: Cost; totalTokens: Cost; pickMs: Cost; askMs: Cost; stages: Record<string, Cost> }; verdict: string }
interface Row { technique: { id: string; name: string; what: string; ontologyDriven: boolean; spec?: string; source?: string; plannedAb?: string };
  comparisons: Comparison[]; preferences?: Array<{ experiment: string; n: number; treatmentWins: number; baselineWins: number; ties: number; p: number }>; verdict: string; missing: string[] }
const L = ledger as unknown as { builtAt: string; rows: Row[]; rule: string };

const TONE: Record<string, string> = {
  'better-and-cheaper': '#15803d', better: '#15803d', 'better-costs-more': '#0f766e', 'same-quality-cheaper': '#0f766e',
  same: '#64748b', 'same-quality-costs-more': '#b45309', worse: '#b91c1c', 'worse-but-cheaper': '#b45309', inconclusive: '#64748b', planned: '#6366f1',
};
const WORDS: Record<string, string> = {
  'better-and-cheaper': 'better and cheaper', better: 'better', 'better-costs-more': 'better, costs more', 'same-quality-cheaper': 'same quality, cheaper',
  same: 'no measurable change', 'same-quality-costs-more': 'same quality, costs more', worse: 'worse', 'worse-but-cheaper': 'worse but cheaper', inconclusive: 'too few cases', planned: 'planned',
};
const pct = (c?: Cost) => (c?.deltaPct === null || c?.deltaPct === undefined ? '—' : `${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}%`);
const num = (x: number | null | undefined, unit = '') => (x === null || x === undefined ? '—' : x >= 1000 ? `${(x / 1000).toFixed(1)}k${unit}` : `${Math.round(x)}${unit}`);

export function TechniqueLedger() {
  const [only, setOnly] = useState<'all' | 'measured' | 'planned' | 'ontology'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const rows = L.rows.filter((r) => only === 'all' || (only === 'planned' ? r.verdict === 'planned' : only === 'measured' ? r.verdict !== 'planned' : r.technique.ontologyDriven));
  return (
    <div data-testid="technique-ledger" style={{ display: 'grid', gap: 12 }}>
      <p className="ui-micro" style={{ margin: 0 }}>Each technique is measured by paired comparisons on the same test cases: quality (the right skill, or the right plan) and cost (tokens to pick, time to pick, the whole ask). ◆ = driven by the ontology or the asker&apos;s typed context. {L.rule}</p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['all', 'measured', 'planned', 'ontology'] as const).map((k) => (
          <button key={k} type="button" className={`btn ${only === k ? '' : 'ghost'}`} onClick={() => setOnly(k)}>{k === 'ontology' ? '◆ ontology-driven' : k}</button>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.technique.id} className="ui-card" style={{ padding: 12 }} data-testid="technique-row">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong>{r.technique.ontologyDriven ? '◆ ' : ''}{r.technique.name}</strong>
            <span style={{ color: TONE[r.verdict] ?? '#64748b', fontWeight: 600 }}>{WORDS[r.verdict] ?? r.verdict}</span>
          </div>
          <div style={{ opacity: 0.8, fontSize: 13, marginTop: 2 }}>{r.technique.what}{r.technique.spec ? ` · spec ${r.technique.spec}` : ''}</div>
          {r.verdict === 'planned' && (
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {r.technique.source && <div style={{ opacity: 0.75 }}>From: {r.technique.source}</div>}
              {r.technique.plannedAb && <div>A/B: {r.technique.plannedAb}</div>}
            </div>
          )}
          {r.comparisons.length > 0 && (
            <table style={{ width: '100%', fontSize: 12, marginTop: 6, borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', opacity: 0.7 }}><th>experiment</th><th>n</th><th>quality</th><th>fixed / broken</th><th>tokens to pick</th><th>time to pick</th><th>whole ask</th><th>verdict</th></tr></thead>
              <tbody>
                {r.comparisons.map((c) => (
                  <tr key={c.experiment + c.treatment} style={{ borderTop: '1px solid var(--color-slate-200, #e2e8f0)' }}>
                    <td title={`${c.baseline} → ${c.treatment}`}>{c.experiment}</td>
                    <td>{c.n}</td>
                    <td>{c.quality.metric === 'plan-exact' ? 'plan ' : ''}{Math.round(c.quality.base * 100)}% → {Math.round(c.quality.treat * 100)}%</td>
                    <td>+{c.quality.fixed} / −{c.quality.broken}{c.quality.p < 0.05 ? ` (p=${c.quality.p})` : ''}</td>
                    <td title={`${num(c.cost.pickTokens.base)} → ${num(c.cost.pickTokens.treat)}`}>{pct(c.cost.pickTokens)}</td>
                    <td title={`${num(c.cost.pickMs.base, 'ms')} → ${num(c.cost.pickMs.treat, 'ms')}`}>{pct(c.cost.pickMs)}</td>
                    <td title={`${num(c.cost.askMs.base, 'ms')} → ${num(c.cost.askMs.treat, 'ms')}`}>{pct(c.cost.askMs)}</td>
                    <td style={{ color: TONE[c.verdict] }}>{WORDS[c.verdict] ?? c.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.preferences?.map((p) => (
            <div key={p.experiment} style={{ fontSize: 12, marginTop: 4 }}>Side by side ({p.experiment}): treatment preferred {p.treatmentWins}, baseline {p.baselineWins}, no difference {p.ties}{p.p < 0.05 ? ` (p=${p.p})` : ` (p=${p.p}, not significant)`}</div>
          ))}
          {r.comparisons.length > 0 && (
            <button type="button" className="btn ghost" style={{ marginTop: 4 }} onClick={() => setOpen(open === r.technique.id ? null : r.technique.id)}>{open === r.technique.id ? 'less' : 'where the time went'}</button>
          )}
          {open === r.technique.id && r.comparisons.map((c) => (
            <div key={`st-${c.experiment}`} style={{ fontSize: 12, marginTop: 4 }}>
              <span style={{ opacity: 0.7 }}>{c.experiment}: </span>
              {Object.entries(c.cost.stages).map(([k, v]) => <span key={k} style={{ marginRight: 10 }}>{k.replace('phase:', '')} {num(v.base, 'ms')} → {num(v.treat, 'ms')} ({pct(v)})</span>)}
              <span>· whole-run tokens {num(c.cost.totalTokens.base)} → {num(c.cost.totalTokens.treat)} ({pct(c.cost.totalTokens)})</span>
            </div>
          ))}
          {r.missing.length > 0 && <div className="ui-micro" style={{ marginTop: 4 }}>not yet run: {r.missing.join(', ')}</div>}
        </div>
      ))}
      <p className="ui-micro">Built {new Date(L.builtAt).toLocaleString()} by <code>ap eval ledger</code> from the eval store.</p>
    </div>
  );
}
