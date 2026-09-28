'use client';
// THE ACT LABORATORY (spec 418 §12 / 420 §4 W6) — the Home's own asks and buttons as intent cases, judged on the act reached:
// the capability, the parties, the amount, whose authority, the receipt — never on the writing. Reads the baked
// `src/evals/act-laboratory.json` (`npx tsx scripts/bake-act-laboratory.mts`). Principles first (what the domain holds and
// how each held up in the latest runs), then every set with its cases and their latest verdicts per variant.
import { useState } from 'react';
import lab from '../../evals/act-laboratory.json';
import { Section, List, Row, Empty, Chip, Mono, Meta, Note } from '../../ui';

type Verdict = { right: number; total: number; failing: string[] };
type Case = { id: string; bucket: string; ask: string; plan: string[]; reply: string | null; capability: string | null; ux: boolean; principles: string[]; checks: string[]; verdicts: Record<string, Verdict> };
type SetV = { id: string; title: string; note: string | null; estate: string | null; latest: { experiment: string; finishedAt: string | null } | null; cases: Case[]; history: Array<{ experiment: string; finishedAt: string | null; variants: Record<string, { right: number; total: number; askMsP50: number | null }> }> };
type Principle = { id: string; area: string; statement: string; violation: string; enforcedBy: string[]; coverage: { right: number; total: number; sets: string[] } };
const L = lab as { bakedAt: string; sets: SetV[]; principles: Principle[] };

const tone = (v: Verdict | undefined): 'ok' | 'warn' | 'danger' | undefined => (!v || !v.total ? undefined : v.right === v.total ? 'ok' : v.right === 0 ? 'danger' : 'warn');
const REPLY_WORDS: Record<string, string> = { authority_required: 'parks for a signature', prompt: 'asks', answer: 'answers', done: 'does', refused: 'refuses' };

export function ActLaboratory() {
  const [openSet, setOpenSet] = useState<string | null>(L.sets[0]?.id ?? null);
  const areas = [...new Set(L.principles.map((p) => p.area))];
  const totals = L.sets.map((s) => { const v = Object.values(s.cases.flatMap((c) => Object.entries(c.verdicts)).reduce<Record<string, Verdict>>((acc, [k, v]) => { const e = (acc[k] ??= { right: 0, total: 0, failing: [] }); e.right += v.right; e.total += v.total; return acc; }, {})); return { id: s.id, cases: s.cases.length, right: v.reduce((n, x) => n + x.right, 0), total: v.reduce((n, x) => n + x.total, 0) }; });
  return (
    <>
      <Section title="The domain's principles" count={L.principles.length} aside={<Meta>right / judged in the latest run of each set · a principle with no enforcer is prose, one with no case is a hope (<Mono>pnpm check:principles</Mono>)</Meta>}>
        {areas.map((area) => (
          <div key={area} style={{ marginBottom: 8 }}>
            <Meta>{area}</Meta>
            <List>
              {L.principles.filter((p) => p.area === area).map((p) => (
                <Row key={p.id} title={<span><Chip tone={p.coverage.total ? (p.coverage.right === p.coverage.total ? 'ok' : 'danger') : undefined}>{p.coverage.total ? `${p.coverage.right}/${p.coverage.total}` : 'untested'}</Chip> {p.statement}</span>}
                  meta={<span><Mono>{p.id}</Mono> · held by {p.enforcedBy.map((e) => <Mono key={e}>{e}</Mono>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, ', ', x] : [x]), [])} · breaks as: {p.violation}{p.coverage.sets.length ? ` · sets: ${p.coverage.sets.join(', ')}` : ''}</span>} />
              ))}
            </List>
          </div>
        ))}
      </Section>
      <Section title="The act sets" count={L.sets.length} aside={<Meta>{totals.map((t) => `${t.id}: ${t.right}/${t.total}`).join(' · ')}</Meta>}>
        {L.sets.length === 0 ? <Empty title="No act sets baked">Run <Mono>npx tsx scripts/bake-act-laboratory.mts</Mono>.</Empty> : (
          <List>
            {L.sets.map((s) => {
              const t = totals.find((x) => x.id === s.id)!;
              const open = openSet === s.id;
              return (
                <div key={s.id}>
                  <Row title={<button type="button" className="btn-ghost" style={{ padding: 0, textAlign: 'left' }} onClick={() => setOpenSet(open ? null : s.id)}><Chip tone={t.total ? (t.right === t.total ? 'ok' : t.right === 0 ? 'danger' : 'warn') : undefined}>{t.total ? `${t.right}/${t.total}` : 'not run'}</Chip> {s.title}</button>}
                    meta={<span>{s.cases.length} cases{s.latest ? ` · latest ${s.latest.experiment}${s.latest.finishedAt ? ` · ${new Date(s.latest.finishedAt).toLocaleString()}` : ''}` : ''}{s.history.length > 1 ? ` · ${s.history.map((h) => Object.entries(h.variants).map(([v, x]) => `${h.experiment}/${v} ${x.right}/${x.total}`).join(', ')).join(' → ')}` : ''}</span>} />
                  {open && (
                    <div style={{ padding: '4px 0 8px 16px' }}>
                      {s.estate && <Note>{s.estate}</Note>}
                      <List>
                        {s.cases.map((c) => (
                          <Row key={c.id} title={<span>{Object.entries(c.verdicts).map(([v, x]) => <Chip key={v} tone={tone(x)} title={x.failing.length ? `failing: ${x.failing.join(', ')}` : undefined}>{v} {x.right}/{x.total}</Chip>)}{c.ux && <Chip>button</Chip>} “{c.ask}”</span>}
                            meta={<span><Mono>{c.id}</Mono> · {c.reply ? REPLY_WORDS[c.reply] ?? c.reply : '—'}{c.capability ? <> · <Mono>{c.capability}</Mono></> : null}{c.checks.length ? ` · checks: ${c.checks.join(', ')}` : ''}{c.principles.length ? ` · principles: ${c.principles.join(', ')}` : ''}{Object.values(c.verdicts).some((x) => x.failing.length) ? ` · failing: ${[...new Set(Object.values(c.verdicts).flatMap((x) => x.failing))].join(', ')}` : ''}</span>} />
                        ))}
                      </List>
                    </div>
                  )}
                </div>
              );
            })}
          </List>
        )}
      </Section>
      <Note>Baked {new Date(L.bakedAt).toLocaleString()} from <Mono>~/skills/evaluations/agentic-trust</Mono> and the eval store. A case is judged deterministically on the reply and the run&rsquo;s provenance; nothing here reads a reply&rsquo;s words.</Note>
    </>
  );
}
