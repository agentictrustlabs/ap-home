// WHAT THE PLAYBOOK REMEMBERS — `playbook.memory:<family>`, the agent's own vault.
//
// THE GAP. A card room reports every finished round to the person's own agent (`poker.review`,
// `canasta.review`) so the agent can remember it. The agent spent a model call on "what is worth
// remembering", returned one sentence, and kept nothing: the next hand's advice knew as much about
// the player across the table as the first hand's did. A review that costs tokens and remembers
// nothing is the worst of both.
//
// WHAT IT IS. A ledger of COUNTS, keyed by subject, folded in WITHOUT A MODEL. The asker sends the
// round as an OBSERVATION — `{ subjects: { <id>: { counters: { hands: 1, vpip: 1, … } } } }` — and
// this file adds the counts to the ones already kept. Nothing here knows what a counter means: that
// the asker defines (a card room's `observeFor`), and the playbook's own skills teach how to read.
// At advice time the subjects PRESENT IN THE MATERIAL are read back, with the rates a model would
// otherwise have to compute — a model reasons well over facts it is handed and badly over facts it
// must derive (the same rule as the card room's `read`).
//
// WHAT IT IS NOT. Not a profile the card room keeps — it keeps none, and has nowhere to put one; this
// is the person's agent's memory, in the person's agent's vault, under the person's own grant, and
// nobody else's. Not authority: a memory of how somebody plays grants nothing and is cited nowhere a
// verifier reads. And not a transcript: only counts survive a round, never cards or amounts.
//
// GAME-AGNOSTIC BY CONSTRUCTION: a family is the skill's first segment (`poker`, `canasta`), a subject
// is whatever id the asker's material uses for a player, and a counter is a number with a name.

/** One remembered subject: how many rounds, when last seen, and the counts. */
export interface RememberedSubjectV1 {
  /** What the asker calls them, if it said. */
  label?: string;
  /** The person whose agent this is — "you", in the counts. */
  you?: boolean;
  rounds: number;
  seen: string;
  counters: Record<string, number>;
}

export interface PlaybookMemoryV1 {
  type: 'ap.playbook-memory.v1';
  family: string;
  rounds: number;
  subjects: Record<string, RememberedSubjectV1>;
  updatedAt: string;
}

/** What one round said about its subjects, as the asker's material carries it. */
export interface RoundObservation {
  subjects: Record<string, { label?: string; you?: boolean; counters: Record<string, number> }>;
}

/** The record type for a skill family. `poker.review` and `poker.advise` share `playbook.memory:poker`. */
export function memoryRecordFor(skill: string): string {
  return `playbook.memory:${familyOf(skill)}`;
}

export function familyOf(skill: string): string {
  return (skill.split('.')[0] ?? skill).trim().toLowerCase() || 'unknown';
}

/** The most subjects one memory keeps. Past it, the longest unseen is forgotten first. */
export const MEMORY_SUBJECT_CAP = 64;

/** Whether the material's `observation` is one this can fold: a `subjects` map of numeric counters. */
export function observationOf(input: unknown): RoundObservation | null {
  const obs = (input as { observation?: unknown } | null | undefined)?.observation;
  if (!obs || typeof obs !== 'object') return null;
  const subjects = (obs as { subjects?: unknown }).subjects;
  if (!subjects || typeof subjects !== 'object') return null;
  const out: RoundObservation = { subjects: {} };
  for (const [id, s] of Object.entries(subjects as Record<string, unknown>)) {
    if (!s || typeof s !== 'object' || !id) continue;
    const counters = (s as { counters?: unknown }).counters;
    if (!counters || typeof counters !== 'object') continue;
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(counters as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    const label = (s as { label?: unknown }).label;
    const you = (s as { you?: unknown }).you === true;
    out.subjects[id] = { counters: clean, ...(typeof label === 'string' && label ? { label } : {}), ...(you ? { you: true } : {}) };
  }
  return Object.keys(out.subjects).length ? out : null;
}

/** The memory with one round's observation added. Pure; `prev` may be anything the vault returned. */
export function foldObservation(prev: unknown, family: string, obs: RoundObservation, now = new Date()): PlaybookMemoryV1 {
  const base = isMemory(prev) && prev.family === family ? prev : { type: 'ap.playbook-memory.v1' as const, family, rounds: 0, subjects: {}, updatedAt: now.toISOString() };
  const seen = now.toISOString();
  const subjects: Record<string, RememberedSubjectV1> = { ...base.subjects };
  for (const [id, s] of Object.entries(obs.subjects)) {
    const was = subjects[id];
    const counters: Record<string, number> = { ...(was?.counters ?? {}) };
    for (const [k, v] of Object.entries(s.counters)) counters[k] = (counters[k] ?? 0) + v;
    subjects[id] = { rounds: (was?.rounds ?? 0) + 1, seen, counters, ...(s.label ? { label: s.label } : was?.label ? { label: was.label } : {}), ...(s.you || was?.you ? { you: true } : {}) };
  }
  // The cap: the longest unseen go first, and never the person's own line.
  const ids = Object.keys(subjects);
  if (ids.length > MEMORY_SUBJECT_CAP) {
    const drop = ids.filter((id) => !subjects[id]!.you).sort((a, b) => subjects[a]!.seen.localeCompare(subjects[b]!.seen)).slice(0, ids.length - MEMORY_SUBJECT_CAP);
    for (const id of drop) delete subjects[id];
  }
  return { type: 'ap.playbook-memory.v1', family, rounds: base.rounds + 1, subjects, updatedAt: seen };
}

export function isMemory(x: unknown): x is PlaybookMemoryV1 {
  return !!x && typeof x === 'object' && (x as PlaybookMemoryV1).type === 'ap.playbook-memory.v1' && typeof (x as PlaybookMemoryV1).subjects === 'object';
}

/**
 * THE SUBJECTS THIS MATERIAL NAMES, with their counts AND their rates.
 *
 * Present means the subject's id appears as a string value somewhere in the material — the seat list
 * of a poker view, say. Nothing about a player who is not at this table is shown: it is not the
 * question, and it is prompt the model pays for. Rates are derived here, deterministically, because
 * "vpip 7 of hands 12" is a division the model would get wrong one time in five and "58%" is not.
 */
export function rememberedFor(memory: unknown, material: unknown, limit = 12): Array<{ id: string; label?: string; you?: boolean; rounds: number; counters: Record<string, number>; rates: Record<string, string> }> {
  if (!isMemory(memory)) return [];
  const present = stringLeaves(material);
  return Object.entries(memory.subjects)
    .filter(([id, s]) => present.has(id) || s.you)
    .sort(([, a], [, b]) => (b.you ? 1 : 0) - (a.you ? 1 : 0) || b.seen.localeCompare(a.seen))
    .slice(0, limit)
    .map(([id, s]) => ({ id, ...(s.label ? { label: s.label } : {}), ...(s.you ? { you: true } : {}), rounds: s.rounds, counters: s.counters, rates: ratesOf(s.counters) }));
}

/**
 * RATES FROM COUNTS, by convention: a counter `x` beside a counter `xOpps` is a rate of `x` per
 * opportunity; the rest are per `hands` when that exists. Named by the asker, computed here.
 */
export function ratesOf(counters: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  const hands = counters.hands ?? 0;
  for (const [k, v] of Object.entries(counters)) {
    if (k === 'hands' || k.endsWith('Opps') || k.startsWith('net')) continue;
    const opps = counters[`${k}Opps`];
    const denom = typeof opps === 'number' ? opps : hands;
    if (denom > 0) out[k] = `${Math.round((v / denom) * 100)}% of ${denom}`;
  }
  return out;
}

function stringLeaves(x: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || x == null) return into;
  if (typeof x === 'string') { into.add(x); return into; }
  if (Array.isArray(x)) { for (const v of x) stringLeaves(v, into, depth + 1); return into; }
  if (typeof x === 'object') { for (const v of Object.values(x as Record<string, unknown>)) stringLeaves(v, into, depth + 1); }
  return into;
}
