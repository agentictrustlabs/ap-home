// THE PULSE A CONTEXT AGENT KEEPS, ANSWERED TO A STRANGER — spec 436 §5.5 T3.
//
// A town or estate context agent is written one record a day, `pulse.day:<YYYY-MM-DD>` (`apinf:TownPulse`,
// Ring 0's `vault-records.ts`), by the town agent under a wire scoped to that one family. This module reads
// those records back out of the agent's OWN vault and answers a question about them in words.
//
// Three rules it keeps, because an answer about money and uptime is worth nothing if they are not kept:
//   · It answers ONLY from records it read, and names every record it used. An answer with no `cited` is a
//     refusal, never a guess — there is no model here and nothing is inferred.
//   · It never reports a figure the record does not carry. A day with no cost is "not recorded", never $0.00.
//   · Counts, never a person: the records are aggregate by construction and nothing here looks for a name.
//
// The question is matched, not understood. That is a deliberate ceiling: a wrong match says "I can answer
// these" and lists them, where a model would compose a confident sentence from the same uncertainty.

export const PULSE_PUBLIC_ASK = 'pulse.public.ask';

/** A day's record as the town writes it. Everything optional: a reader never assumes a field it did not see. */
export interface PulseDayRecord {
  type?: string;
  day?: string;
  samples?: number;
  services?: Record<string, { samples?: number; up?: number }>;
  chain?: unknown;
  inference?: unknown;
  estates?: Record<string, unknown>;
  estate?: string;
  heartbeat?: { runs?: { completed?: number; failed?: number; total?: number }; inferenceMicroUsd?: number | null } | null;
  pulse?: {
    infrastructure?: Array<{ platform?: string; resource?: string; latest?: { status?: string; ok?: boolean } }>;
    cost?: Array<{ platform?: string; basis?: string; days?: Array<{ day?: string; amountMicroUsd?: number }> }>;
    costPerCompletedRun?: { microUsd?: number | null; completedRuns?: number; infraBasis?: string | null } | null;
  };
}

export type PulseSubject = 'overall' | 'cost' | 'status' | 'runs';

/** The window a question asks about, in whole UTC days ending today. */
export interface PulseWindow { from: string; to: string; days: string[]; words: string }

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The days a question names. Matched on words, and `7d` when it names none — said out loud in `words`. */
export function windowOf(question: string, nowMs: number): PulseWindow {
  const q = question.toLowerCase();
  const today = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const span = (n: number, words: string, endOffset = 0): PulseWindow => {
    const days = Array.from({ length: n }, (_, i) => dayOf(today - (n - 1 - i + endOffset) * 86_400_000));
    return { from: days[0]!, to: days[days.length - 1]!, days, words };
  };
  if (/\byesterday\b/.test(q)) return span(1, 'yesterday', 1);
  if (/\btoday\b|\bright now\b|\bnow\b/.test(q)) return span(1, 'today');
  if (/\b(30|thirty)\s*(d|days)\b|\blast month\b|\bthis month\b/.test(q)) return span(30, 'the last 30 days');
  if (/\b(14|fourteen)\s*(d|days)\b|\bfortnight\b|\btwo weeks\b/.test(q)) return span(14, 'the last 14 days');
  if (/\bweek\b|\b(7|seven)\s*(d|days)\b/.test(q)) return span(7, 'the last 7 days');
  const n = q.match(/\blast\s+(\d{1,2})\s*days?\b/);
  if (n) { const k = Math.min(90, Math.max(1, Number(n[1]))); return span(k, `the last ${k} days`); }
  return span(7, 'the last 7 days');
}

/** What the question is about. `overall` is the honest default — it reports everything the records carry. */
export function subjectOf(question: string): PulseSubject {
  const q = question.toLowerCase();
  if (/\bcost|spend|spent|token|bill|charge|price|\$|usd\b/.test(q)) return 'cost';
  if (/\bdown|outage|up\b|uptime|status|healthy|available|broke|failing\b/.test(q)) return 'status';
  if (/\brun|ask|request|throughput|latency|duration|how many\b/.test(q)) return 'runs';
  return 'overall';
}

const usd = (micro: number): string => `$${(micro / 1e6).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Every cost figure a day's record carries, by basis — the bases are never added together (spec 437 I1). */
function costOf(rec: PulseDayRecord): Map<string, number> {
  const by = new Map<string, number>();
  for (const row of rec.pulse?.cost ?? []) {
    const basis = row.basis ?? 'unlabelled';
    const sum = (row.days ?? []).reduce((n, d) => n + (typeof d.amountMicroUsd === 'number' ? d.amountMicroUsd : 0), 0);
    by.set(basis, (by.get(basis) ?? 0) + sum);
  }
  return by;
}

export interface PulseAnswer {
  answer: string;
  /** Every record the answer was read from. An answer that cites nothing is a refusal. */
  cited: Array<{ key: string; day: string }>;
  window: { from: string; to: string; words: string };
  subject: PulseSubject;
  read: boolean;
}

/**
 * Answer one question from the days given. Pure: the caller does the reading, this composes the words — so the
 * whole of it is testable without a vault, which is the only way a sentence about money gets to be trusted.
 */
export function answerFromDays(question: string, window: PulseWindow, found: Array<{ day: string; rec: PulseDayRecord }>): PulseAnswer {
  const subject = subjectOf(question);
  const cited = found.map((f) => ({ key: `pulse.day:${f.day}`, day: f.day }));
  const head = { window: { from: window.from, to: window.to, words: window.words }, subject, cited };
  if (!found.length) {
    return { ...head, read: false, answer: `I keep one record a day and I have none for ${window.words}. Nothing is inferred from an absent record, so there is nothing I can tell you about it.` };
  }
  const parts: string[] = [];

  if (subject === 'cost' || subject === 'overall') {
    const by = new Map<string, number>();
    let daysWithCost = 0;
    for (const { rec } of found) { const c = costOf(rec); if (c.size) daysWithCost += 1; for (const [b, v] of c) by.set(b, (by.get(b) ?? 0) + v); }
    if (!by.size) parts.push(`No infrastructure cost is recorded for ${window.words}.`);
    else parts.push(`Infrastructure over ${window.words}: ${[...by.entries()].map(([b, v]) => `${usd(v)} ${b}`).join(', ')} — across ${plural(daysWithCost, 'day')} that carry a cost. The bases are different measurements and are never added together.`);

    const inf = found.map(({ rec }) => rec.heartbeat?.inferenceMicroUsd).filter((x): x is number => typeof x === 'number');
    if (inf.length) parts.push(`Inference the estate reported: ${usd(inf.reduce((a, b) => a + b, 0))} over ${plural(inf.length, 'day')}.`);
    else if (subject === 'cost') parts.push('No inference cost is recorded in these days.');
  }

  if (subject === 'status' || subject === 'overall') {
    const trouble = new Map<string, Set<string>>();
    for (const { day, rec } of found) for (const r of rec.pulse?.infrastructure ?? []) {
      if (r.latest && (r.latest.ok === false || (r.latest.status && r.latest.status !== 'up'))) {
        const k = r.resource ?? '?'; trouble.set(k, (trouble.get(k) ?? new Set()).add(day));
      }
    }
    const svc = new Map<string, { samples: number; up: number }>();
    for (const { rec } of found) for (const [id, s] of Object.entries(rec.services ?? {})) {
      const cur = svc.get(id) ?? { samples: 0, up: 0 };
      svc.set(id, { samples: cur.samples + (s.samples ?? 0), up: cur.up + (s.up ?? 0) });
    }
    const never = [...svc.entries()].filter(([, s]) => s.samples > 0 && s.up === 0).map(([id]) => id);
    const sometimes = [...svc.entries()].filter(([, s]) => s.samples > 0 && s.up > 0 && s.up < s.samples).map(([id, s]) => `${id} (${s.up} of ${s.samples} probes)`);
    if (!svc.size && !trouble.size) parts.push(`No service probe is recorded for ${window.words}.`);
    else {
      if (never.length) parts.push(`Never answered in ${window.words}: ${never.join(', ')}.`);
      if (sometimes.length) parts.push(`Answered some of the time: ${sometimes.join(', ')}.`);
      if (!never.length && !sometimes.length && svc.size) parts.push(`Every one of ${plural(svc.size, 'service')} answered every probe in ${window.words}.`);
      if (trouble.size) parts.push(`Infrastructure not reading as up: ${[...trouble.entries()].map(([r, ds]) => `${r} on ${plural(ds.size, 'day')}`).join(', ')}.`);
    }
  }

  if (subject === 'runs' || subject === 'overall') {
    const completed = found.reduce((n, { rec }) => n + (rec.heartbeat?.runs?.completed ?? 0), 0);
    const failed = found.reduce((n, { rec }) => n + (rec.heartbeat?.runs?.failed ?? 0), 0);
    const per = found.map(({ rec }) => rec.pulse?.costPerCompletedRun).filter((x): x is NonNullable<typeof x> => !!x && typeof x.microUsd === 'number');
    if (completed || failed) parts.push(`Runs the estate reported: ${plural(completed, 'completed run')}${failed ? `, ${plural(failed, 'failure')}` : ''}.`);
    else if (subject === 'runs') parts.push(`No run counts are recorded for ${window.words}.`);
    if (per.length) parts.push(`Cost per completed run, last recorded: ${usd(per[per.length - 1]!.microUsd!)}${per[per.length - 1]!.infraBasis ? ` (infrastructure on the ${per[per.length - 1]!.infraBasis} basis)` : ''}.`);
  }

  const missing = window.days.filter((d) => !found.some((f) => f.day === d));
  if (missing.length) parts.push(`${plural(missing.length, 'day')} in the window ${missing.length === 1 ? 'has' : 'have'} no record, so this is partial — never a smaller total.`);
  return { ...head, read: true, answer: parts.join(' ') };
}

/** The whole capability: read the window's records from the agent's own vault, then answer from them. */
export async function publicPulseAsk(
  deps: { readSubjectRecord: (subject: string, recordType: string) => Promise<unknown> },
  owner: string,
  args: Record<string, unknown>,
  nowMs = Date.now(),
): Promise<Record<string, unknown>> {
  const question = typeof args.question === 'string' ? args.question : typeof args.q === 'string' ? args.q : '';
  const window = windowOf(question, nowMs);
  const found: Array<{ day: string; rec: PulseDayRecord }> = [];
  for (const day of window.days) {
    const rec = (await deps.readSubjectRecord(owner, `pulse.day:${day}`).catch(() => null)) as PulseDayRecord | null;
    if (rec && typeof rec === 'object') found.push({ day, rec });
  }
  const a = answerFromDays(question, window, found);
  return { ...a, owner, question };
}
