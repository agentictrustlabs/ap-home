// RUN A COMPARISON — THE DEFAULTS, AND THE WORDS (owner, 2026-10-01: "an ask interface that defaults all of these
// configuration and then I can change from the default so I don't need to know what to originally set these values to").
//
// Everything on the form has a default a person can run as-is: the first organization they steward, the recommended
// test set, two arms (the live default against the one thing most worth comparing on this deployment), held-out, one
// repeat. "Tell me what to compare" is a DETERMINISTIC reading of a sentence over the knobs the deployment offers —
// provider names, judge modes, selection arms, repeats, split, a set's name — never a model guessing a config. It says
// back exactly what it understood; everything it did not mention stays at the default. Pure; tested.
import type { ComparisonKnobsV1 } from './experiments';

/** `toggles` holds the arm's OTHER deployment toggles (anything but `quality/judge`, which is `judge`) — set by a deep
 *  link's `arms` (e.g. `plan/chain-proceed: on`), each one already checked against what this deployment offers. */
export interface ArmRow { name: string; provider: string; selectionProvider: string; answerProvider: string; judgeProvider: string; judgeProfile: string; judge: string; selection: string; toggles?: Record<string, string> }
export interface EvalSetSummary { id: string; domain: string; title: string; cases: number; fixtures: boolean; recommended: boolean }
export interface ComparisonDraft { setId: string; rows: ArmRow[]; split: 'held-out' | 'development' | 'all'; repeats: number }

export const emptyArm = (name: string): ArmRow => ({ name, provider: '', selectionProvider: '', answerProvider: '', judgeProvider: '', judgeProfile: '', judge: 'outcome', selection: '' });

/** The two arms worth running first: the live default, and the next provider this deployment offers (or, with one
 *  provider, the rule-based selector against the model). */
export function defaultArms(knobs: Pick<ComparisonKnobsV1, 'providers' | 'selections'>): ArmRow[] {
  const control = emptyArm('control');
  const second = knobs.providers[1];
  if (second) return [control, { ...emptyArm('treatment'), provider: second }];
  const rules = knobs.selections.find((s) => /rule/i.test(s));
  if (rules) return [control, { ...emptyArm('treatment'), selection: rules }];
  return [control, { ...emptyArm('treatment'), judgeProfile: 'fast' }];
}

export function defaultDraft(knobs: Pick<ComparisonKnobsV1, 'providers' | 'selections'>, sets: readonly EvalSetSummary[]): ComparisonDraft {
  const rec = sets.find((s) => s.recommended) ?? sets[0];
  return { setId: rec?.id ?? '', rows: defaultArms(knobs), split: 'held-out', repeats: 1 };
}

/** One sentence of what will run, for the person who changes nothing. */
export function readyWords(d: ComparisonDraft, orgName: string | null, sets: readonly EvalSetSummary[]): string {
  const set = sets.find((s) => s.id === d.setId);
  const diff = d.rows.slice(1).map((r) => armWords(r, d.rows[0]!)).filter(Boolean).join('; ');
  return `${orgName ?? 'the organization you choose'} · ${set ? `${set.title} (${set.cases} cases)` : 'a set you upload'} · ${d.rows.map((r) => r.name).join(' vs ')}${diff ? ` (${diff})` : ''} · ${d.split} · ${d.repeats} repeat${d.repeats === 1 ? '' : 's'}`;
}

/** How one arm differs from the control, in words; '' when it is the same. */
export function armWords(r: ArmRow, control: ArmRow): string {
  const parts: string[] = [];
  if (r.provider !== control.provider) parts.push(`provider ${r.provider || 'default'}`);
  if (r.selectionProvider !== control.selectionProvider) parts.push(`selects with ${r.selectionProvider || 'default'}`);
  if (r.answerProvider !== control.answerProvider) parts.push(`answers with ${r.answerProvider || 'default'}`);
  if (r.judgeProvider !== control.judgeProvider) parts.push(`judges with ${r.judgeProvider || 'default'}`);
  if (r.judgeProfile !== control.judgeProfile) parts.push(`judge profile ${r.judgeProfile || 'thorough'}`);
  if (r.judge !== control.judge) parts.push(`judge mode ${r.judge}`);
  if (r.selection !== control.selection) parts.push(`selection ${r.selection || 'model'}`);
  const a = r.toggles ?? {}, b = control.toggles ?? {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (a[k] !== b[k]) parts.push(`${k} ${a[k] ?? 'default'}`);
  return parts.join(', ');
}

/**
 * Read a sentence against the knobs. Understood phrases, each applied to the TREATMENT arm unless the sentence says
 * "both" or "control":
 *   "compare gemini and groq" / "gemini vs groq"  → control provider gemini, treatment provider groq
 *   "<provider>"                                   → treatment provider
 *   "judge outcome|pairwise|on|off"                → judge mode (both arms when "both")
 *   "judge with <provider>" · "answer with <p>" · "select with <p>"
 *   "rules" / "rule-based"                         → treatment selection = the rule-based arm
 *   "3 repeats" / "repeat 3 times"                 → repeats
 *   "all cases" / "held-out" / "development"       → split
 *   a set id or a distinctive part of its title     → set
 * Returns the new draft and the list of what was understood; an empty list means nothing changed.
 */
export function applyWords(text: string, knobs: Pick<ComparisonKnobsV1, 'providers' | 'selections' | 'toggles'>, sets: readonly EvalSetSummary[], draft: ComparisonDraft): { draft: ComparisonDraft; understood: string[]; ignored: string[] } {
  const t = text.toLowerCase();
  const understood: string[] = [];
  const ignored: string[] = [];
  const rows = draft.rows.map((r) => ({ ...r }));
  const control = rows[0]!;
  const treatment = rows[1] ?? (rows.push(emptyArm('treatment')), rows[1]!);
  const both = /\bboth\b/.test(t);
  const providers = knobs.providers.map((p) => p.toLowerCase());
  const judgeModes = [...(knobs.toggles['quality/judge'] ?? ['off', 'on', 'pairwise', 'outcome'])].map((m) => m.toLowerCase());

  // "X vs Y" / "compare X and Y" / "X against Y" — two providers.
  const pair = new RegExp(`\\b(${providers.join('|')})\\b\\s*(?:vs\\.?|versus|against|and|,)\\s*\\b(${providers.join('|')})\\b`).exec(t);
  if (pair && providers.length >= 2) {
    control.provider = knobs.providers[providers.indexOf(pair[1]!)]!;
    treatment.provider = knobs.providers[providers.indexOf(pair[2]!)]!;
    understood.push(`control uses ${control.provider}, treatment uses ${treatment.provider}`);
  }
  // role-specific: "judge with X", "answer with X", "select with X"
  for (const [role, key, words] of [['judge', 'judgeProvider', 'judges with'], ['answer', 'answerProvider', 'answers with'], ['select', 'selectionProvider', 'selects with']] as const) {
    const m = new RegExp(`\\b${role}\\w*\\s+(?:with|using|by)\\s+(${providers.join('|')})\\b`).exec(t);
    if (m) { const p = knobs.providers[providers.indexOf(m[1]!)]!; treatment[key] = p; if (both) control[key] = p; understood.push(`${both ? 'both arms' : 'treatment'} ${words} ${p}`); }
  }
  // a lone provider name (not already consumed by the pair or a role) → treatment provider
  if (!pair) {
    const lone = providers.find((p) => new RegExp(`\\b${p}\\b`).test(t) && !new RegExp(`(?:with|using|by)\\s+${p}\\b`).test(t));
    if (lone) { const p = knobs.providers[providers.indexOf(lone)]!; treatment.provider = p; if (both) control.provider = p; understood.push(`${both ? 'both arms use' : 'treatment uses'} ${p}`); }
  }
  // judge mode
  const jm = new RegExp(`\\bjudge\\s+(?:mode\\s+)?(${judgeModes.join('|')})\\b`).exec(t) ?? new RegExp(`\\b(${judgeModes.filter((m) => m !== 'on' && m !== 'off').join('|')})\\s+judge\\b`).exec(t);
  if (jm) { const mode = jm[1]!; treatment.judge = mode; if (both) control.judge = mode; understood.push(`${both ? 'both arms' : 'treatment'} judge mode ${mode}`); }
  if (/\bno judge\b|\bjudge off\b|\bwithout (?:a )?judge\b/.test(t)) { treatment.judge = 'off'; if (both) control.judge = 'off'; understood.push(`${both ? 'both arms' : 'treatment'} judge off`); }
  // judge profile
  const jp = /\b(thorough|fast|logprob)\b/.exec(t);
  if (jp) { treatment.judgeProfile = jp[1]!; if (both) control.judgeProfile = jp[1]!; understood.push(`${both ? 'both arms' : 'treatment'} judge profile ${jp[1]}`); }
  // selection arm
  const rules = knobs.selections.find((s) => /rule/i.test(s));
  if (rules && /\brules?\b|rule-based|\bdeterministic\b/.test(t)) { treatment.selection = rules; understood.push(`treatment selects with ${rules}`); }
  // repeats
  const rep = /\b(\d{1,2})\s*(?:x|times|repeats?)\b/.exec(t) ?? /\brepeats?\s*(?:of\s*)?(\d{1,2})\b/.exec(t);
  let repeats = draft.repeats;
  if (rep) { repeats = Math.max(1, Math.min(10, Number(rep[1]))); understood.push(`${repeats} repeat${repeats === 1 ? '' : 's'}`); }
  // split
  let split = draft.split;
  if (/\ball (?:the )?cases\b|\beverything\b|\bwhole set\b/.test(t)) { split = 'all'; understood.push('split: all cases'); }
  else if (/\bheld[- ]?out\b/.test(t)) { split = 'held-out'; understood.push('split: held-out'); }
  else if (/\bdevelopment\b|\bdev set\b/.test(t)) { split = 'development'; understood.push('split: development'); }
  // the set, by id or by a distinctive word of its title
  let setId = draft.setId;
  const byId = sets.find((s) => t.includes(s.id.toLowerCase()));
  const byTitle = byId ?? sets.find((s) => { const w = s.title.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4); return w.length > 0 && w.every((x) => t.includes(x)); });
  if (byTitle) { setId = byTitle.id; understood.push(`set ${byTitle.title}`); }
  // what we could not place: provider-looking words we do not offer
  for (const w of t.match(/\b(openai|anthropic|claude|gpt-?\d*|gemini|groq|llama|mistral)\b/g) ?? []) if (!providers.includes(w) && !ignored.includes(w)) ignored.push(w);

  return { draft: { setId, rows, split, repeats }, understood, ignored: ignored.filter((w) => !understood.some((u) => u.includes(w))) };
}
