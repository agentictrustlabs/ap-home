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
//     This holds for the town of names too — "86 names under .me" is what the record says, and "who are they"
//     is a question it cannot be made to answer, because no name and no owner was ever written into it.
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
  /**
   * THE TOWN'S RECORD HOLDS ONE HEARTBEAT PER ESTATE, keyed by estate id — and each one carries that estate's
   * own CENSUS (`agents: { person, org, service }`). Typed as `unknown` this was unreadable, so "how many
   * agents are in town" was answered about runs while the answer sat in the record (seen 2026-10-12).
   */
  estates?: Record<string, EstateHeartbeat | unknown>;
  estate?: string;
  heartbeat?: EstateHeartbeat | null;
  /**
   * THE TOWN OF NAMES, in counts per root (spec 430, written by the town from `namesSampleOf`). A count, never a
   * person: no name and no owner is carried, so "how many people are named here?" is answerable and "who are they?"
   * is not. Only the TOWN's record has this — a root is shared by every estate that names under it, so a
   * town-wide count in one estate's record would read as that estate's own.
   */
  names?: { chainId?: number | null; block?: number | null; total?: number; roots?: Array<{ tld?: string; kind?: string | null; names?: string | null; count?: number }> } | null;
  pulse?: {
    /**
     * THE RECORDED SHAPE IS FLAT. `dayRollup` writes `{ platform, account, resource, kind, owner, status,
     * ok, asOf, lagClass, metrics }` per resource — the live `/api/pulse` view nests the same facts under
     * `latest`, and reading the record as though it were the live view found platform and owner and no
     * status, no reading, no metrics at all. Both are accepted here so a reader of either is right.
     */
    infrastructure?: Array<{
      platform?: string; account?: string; resource?: string; kind?: string;
      owner?: { kind?: string; id?: string } | null;
      status?: string; ok?: boolean; asOf?: string; lagClass?: string; error?: string; metrics?: Record<string, number | null>;
      latest?: { status?: string; ok?: boolean; asOf?: string; lagClass?: string; error?: string; metrics?: Record<string, number | null> };
    }>;
    cost?: Array<{ platform?: string; basis?: string; owner?: { kind?: string; id?: string } | null; days?: Array<{ day?: string; amountMicroUsd?: number }> }>;
    costPerCompletedRun?: { microUsd?: number | null; completedRuns?: number; infraBasis?: string | null } | null;
    unattributed?: Array<{ platform?: string; resource?: string; kind?: string }>;
  };
}

/** As much of an estate's heartbeat as a reader of these records needs. Everything optional, as ever. */
export interface EstateHeartbeat {
  /** The estate's own census: how many agents of each kind it holds. A RUNNING TOTAL, never a day's flow. */
  agents?: Record<string, number | null>;
  homesActive24h?: number | null;
  runs?: { completed?: number; failed?: number; total?: number };
  inferenceMicroUsd?: number | null;
}

export type PulseSubject = 'overall' | 'cost' | 'status' | 'runs' | 'names' | 'agents';

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
  // NAMES BEFORE RUNS, because "how many names are there?" matches `how many` and is not a question about runs.
  if (/\bnames?\b|\bnamed\b|\bregistered\b|\broots?\b|\btlds?\b|\bendings?\b/.test(q)) return 'names';
  // AND THE CENSUS BEFORE RUNS, for the same reason: "how many agents are in town" counts agents, not runs.
  if (/\bagents?\b|\bcensus\b|\bpopulation\b|\bresidents?\b|\blives? here\b/.test(q)) return 'agents';
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

/**
 * ── RETRIEVAL ────────────────────────────────────────────────────────────────────────────────────────
 * What the question NAMES, found in the records. A town's day holds a hundred and fifty resources, every
 * service's probe counts and each estate's run counts, so "tell me about demo-a2a-faithnet" is answerable
 * exactly — the old answerer simply never looked at the subject and read the week back instead.
 *
 * Matching is by NAME, against names the records themselves carry: nothing is invented, and a name the
 * records do not know is reported as unknown rather than guessed at. The result is a bounded set of facts
 * drawn only from records that were read, which is the whole of what any answer may say.
 */
export interface PulseNamedThing {
  name: string;
  what: string;
  /** Facts in the order a reader wants them; every value came out of a record. */
  facts: Record<string, string | number>;
  days: string[];
}

/** A resource's reading, from whichever shape it came in: the record is flat, the live view nests. */
export function reading(r: { status?: string; ok?: boolean; asOf?: string; lagClass?: string; error?: string; metrics?: Record<string, number | null>; latest?: { status?: string; ok?: boolean; asOf?: string; lagClass?: string; error?: string; metrics?: Record<string, number | null> } }): { status?: string; ok?: boolean; asOf?: string; lagClass?: string; error?: string; metrics?: Record<string, number | null> } {
  return r.latest ?? r;
}

const METRIC_WORD: Record<string, string> = {
  requests: 'requests', errors: 'errors', subrequests: 'subrequests',
  cpuP50Ms: 'CPU p50 (ms)', cpuP99Ms: 'CPU p99 (ms)', wallP50Ms: 'wall p50 (ms)', wallP99Ms: 'wall p99 (ms)',
  rowsRead: 'rows read', rowsWritten: 'rows written', readQueries: 'read queries', writeQueries: 'write queries',
  storageBytes: 'stored bytes', cpuPercent: 'CPU %', deployAgeMs: 'deploy age (ms)',
  queryBatchTimeP50Ms: 'query p50 (ms)', queryBatchTimeP99Ms: 'query p99 (ms)',
  statements: 'statements', heapUsedBytes: 'heap used', requestsPerMinute: 'requests/min',
};

/**
 * ── THE TOWN OF NAMES ──────────────────────────────────────────────────────────────
 * One row per root, as the record carries it. A COUNT IS NOT A SUM OVER DAYS: a root's count is the registry's
 * running total, so the latest day that recorded it IS the count — adding yesterday's 85 to today's 86 would
 * invent 171 names, which is the exact shape of error these records exist to prevent.
 */
export interface PulseRoot { tld: string; kind: string | null; names: string | null; count: number; day: string }
export function rootsIn(found: Array<{ day: string; rec: PulseDayRecord }>): PulseRoot[] {
  const by = new Map<string, PulseRoot>();
  for (const { day, rec } of found) {
    for (const r of rec.names?.roots ?? []) {
      const tld = String(r.tld ?? '').toLowerCase();
      if (!tld) continue;
      const prev = by.get(tld);
      if (prev && prev.day > day) continue;  // a later day already read it
      by.set(tld, { tld, kind: r.kind ?? null, names: r.names ?? null, count: typeof r.count === 'number' ? r.count : 0, day });
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.tld.localeCompare(b.tld));
}

/**
 * The words a question may use for a kind of name: the kind the record itself carries, and the plural a person
 * actually types — `people` for `person`, `churches` for `church`, `treasuries` for `treasury`. Nothing is
 * invented: a kind the records do not carry has no words here and is never matched.
 */
export function kindWords(kind: string | null): string[] {
  const k = (kind ?? '').toLowerCase().trim();
  if (!/^[a-z]+$/.test(k)) return [];
  const plural = k === 'person' ? 'people' : /(?:ch|sh|s|x|z)$/.test(k) ? `${k}es` : /[^aeiou]y$/.test(k) ? `${k.slice(0, -1)}ies` : `${k}s`;
  return [k, plural];
}

/**
 * A COUNTING PHRASE, and the few words a question may put between it and the thing counted: "how many
 * people", "the number of active churches". One definition, used by the roots and by the census — the rule
 * is the same in both places and two spellings of it would drift.
 */
const COUNTING = String.raw`\b(?:how many|how much|number of|count of|total)\b(?:\s+\w+){0,3}?\s+`;

/**
 * The roots a question asks the COUNT of — "how many people do we have?", "the number of churches", ".me".
 *
 * A kind word only counts when a COUNTING PHRASE introduces it, because "the naming service" says `service`
 * while asking about a service and not about `.svc`. A root named outright with its dot needs no phrase: the
 * dot is what makes `.me` a root rather than an English word.
 */
export function rootsAsked(question: string, roots: PulseRoot[]): string[] {
  const q = question.toLowerCase();
  const hit: string[] = [];
  for (const r of roots) {
    if (q.includes(`.${r.tld}`)) { hit.push(r.tld); continue; }
    for (const w of kindWords(r.kind)) {
      if (new RegExp(`${COUNTING}${w}\\b`).test(q)) { hit.push(r.tld); break; }
    }
  }
  return hit;
}

/**
 * ── THE CENSUS ─────────────────────────────────────────────────────────────────────────
 * How many agents each estate holds, as the estate itself reported. Like a root's count this is a RUNNING
 * TOTAL, so the latest day that recorded an estate is that estate's count — never a sum over days. Across
 * ESTATES on one day it does add up: a different estate is a different set of Smart Agents.
 *
 * A count of AGENTS is not a count of NAMES and not a count of people. An estate reporting 80 person agents
 * and a `.me` root holding 86 names are two different facts, and an answer that conflates them is wrong even
 * when both numbers are right — so both are reported, each said for what it is.
 */
export interface PulseCensus { estate: string; day: string; agents: Record<string, number>; homesActive24h: number | null }
export function censusIn(found: Array<{ day: string; rec: PulseDayRecord }>): PulseCensus[] {
  const by = new Map<string, PulseCensus>();
  const take = (estate: string, day: string, hb: EstateHeartbeat | null | undefined) => {
    if (!hb || typeof hb !== 'object') return;
    const agents: Record<string, number> = {};
    for (const [kind, n] of Object.entries(hb.agents ?? {})) if (typeof n === 'number' && Number.isFinite(n)) agents[kind] = n;
    if (!Object.keys(agents).length) return;
    const prev = by.get(estate);
    if (prev && prev.day > day) return;
    by.set(estate, { estate, day, agents, homesActive24h: typeof hb.homesActive24h === 'number' ? hb.homesActive24h : null });
  };
  for (const { day, rec } of found) {
    // The TOWN's record: one heartbeat per estate, keyed by id. An ESTATE's own: its slice, under `heartbeat`.
    for (const [estate, hb] of Object.entries(rec.estates ?? {})) take(estate, day, hb as EstateHeartbeat);
    if (rec.estate) take(rec.estate, day, rec.heartbeat);
  }
  return [...by.values()].sort((a, b) => a.estate.localeCompare(b.estate));
}

/** Every agent kind the census carries, across the estates — the only kinds a question may be matched against. */
export const censusKinds = (census: PulseCensus[]): string[] =>
  [...new Set(census.flatMap((c) => Object.keys(c.agents)))].sort();

/**
 * What the question asks the census for: `agents` (every kind) or `agents:<kind>`.
 *
 * The same counting-phrase rule the roots use, and for the same reason. The bare word "agents" is enough on
 * its own — there is no other thing in these records called that — while a KIND word needs the phrase, so
 * "the naming service" still asks about a service and not about the service agents.
 */
export function censusAsked(question: string, census: PulseCensus[]): string[] {
  const q = question.toLowerCase();
  const asked: string[] = [];
  for (const kind of censusKinds(census)) {
    for (const w of kindWords(kind)) {
      if (new RegExp(`${COUNTING}${w}\\b`).test(q)) { asked.push(`agents:${kind}`); break; }
    }
  }
  // "how many agents", "what is the census", "who lives here" — every kind, which is also the town's total.
  if (census.length && /\bagents?\b|\bcensus\b|\bpopulation\b|\bresidents?\b|\blives? here\b/.test(q)) asked.unshift('agents');
  return [...new Set(asked)];
}

/** Every name the records know, so a question can be matched against reality and nothing else. */
export function namesIn(found: Array<{ day: string; rec: PulseDayRecord }>): Set<string> {
  const names = new Set<string>();
  for (const { rec } of found) {
    for (const id of Object.keys(rec.services ?? {})) names.add(id.toLowerCase());
    for (const r of rec.pulse?.infrastructure ?? []) if (r.resource && r.resource !== '*') names.add(r.resource.toLowerCase());
    for (const e of Object.keys(rec.estates ?? {})) names.add(e.toLowerCase());
    if (rec.estate) names.add(rec.estate.toLowerCase());
    for (const c of rec.pulse?.cost ?? []) if (c.platform) names.add(c.platform.toLowerCase());
    // A root is named with its dot — `.me`, `.org`. Without it, `me` and `org` are English words in a sentence.
    for (const r of rec.names?.roots ?? []) if (r.tld) names.add(`.${String(r.tld).toLowerCase()}`);
  }
  return names;
}

/**
 * Identifier-shaped words — `demo-a2a-faithnet`, `town-mcp`, `faithnet.io`. When a question names one of
 * these and the records know nothing by that name, saying so is far more use than answering about the
 * week instead. Only consulted when NOTHING known was named, so an ordinary hyphenated word in a question
 * that did match something is never reported as a missing resource.
 */
const HYPHENATED_ENGLISH = new Set(['open-ended', 'read-only', 'up-to-date', 'real-time', 'end-to-end', 'day-to-day', 'well-known', 'self-hosted', 'fail-closed', 'per-day']);
export function identifierish(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+/g) ?? []))]
    .filter((t) => t.length >= 4 && !HYPHENATED_ENGLISH.has(t))
    .slice(0, 3);
}

/** The names this question mentions, longest first so `demo-a2a-faithnet` wins over `faithnet`. */
export function subjectsNamed(question: string, found: Array<{ day: string; rec: PulseDayRecord }>): string[] {
  const q = question.toLowerCase();
  const all = [...namesIn(found)].sort((a, b) => b.length - a.length);
  const hit: string[] = [];
  for (const n of all) {
    if (n.length < 3 || !q.includes(n)) continue;
    // A name already covered by a longer one that matched is the same mention, not a second subject.
    if (hit.some((h) => h.includes(n))) continue;
    hit.push(n);
  }
  return hit.slice(0, 4);
}

/** Everything the records say about one named thing, across the window. */
export function factsAbout(name: string, found: Array<{ day: string; rec: PulseDayRecord }>): PulseNamedThing | null {
  const key = name.toLowerCase();
  const facts: Record<string, string | number> = {};
  const days: string[] = [];
  let what = '';
  // A ROOT, BY ITS COUNT — taken from the latest day that recorded it, never summed across days (see `rootsIn`).
  if (key.startsWith('.')) {
    const root = rootsIn(found).find((r) => r.tld === key.slice(1));
    if (!root) return null;
    return {
      name: `.${root.tld}`,
      what: root.names ? `the root that names ${root.names}` : 'a root with no declared kind (legacy)',
      facts: { names: root.count, 'counted on': root.day },
      days: [root.day],
    };
  }
  for (const { day, rec } of found) {
    let touched = false;
    // A declared service, as the town's own probe saw it.
    const svc = Object.entries(rec.services ?? {}).find(([id]) => id.toLowerCase() === key);
    if (svc) {
      what ||= 'a service the town lists and probes';
      facts['probes'] = Number(facts['probes'] ?? 0) + (svc[1].samples ?? 0);
      facts['answered'] = Number(facts['answered'] ?? 0) + (svc[1].up ?? 0);
      touched = true;
    }
    // A resource a platform reports, with its last reading.
    const res = (rec.pulse?.infrastructure ?? []).find((r) => (r.resource ?? '').toLowerCase() === key);
    if (res) {
      const r = reading(res);
      what ||= `a ${res.kind ?? 'resource'} on ${res.platform ?? 'a platform'}`;
      facts['platform'] = res.platform ?? '?';
      facts['kind'] = res.kind ?? '?';
      facts['owner'] = res.owner ? `${res.owner.kind}:${res.owner.id}` : 'not attributed in the manifest';
      if (r.status) facts['status'] = r.status;
      if (r.asOf) facts['last read'] = r.asOf;
      if (r.lagClass) facts['how current'] = r.lagClass;
      if (r.error) facts['unreadable because'] = r.error;
      for (const [k, v] of Object.entries(r.metrics ?? {})) if (typeof v === 'number') facts[METRIC_WORD[k] ?? k] = v;
      touched = true;
    }
    // An estate, as it reported itself.
    if ((rec.estate ?? '').toLowerCase() === key || Object.keys(rec.estates ?? {}).some((e) => e.toLowerCase() === key)) {
      what ||= 'an estate on this chain';
      if (rec.heartbeat?.runs) {
        facts['completed runs'] = Number(facts['completed runs'] ?? 0) + (rec.heartbeat.runs.completed ?? 0);
        facts['failed runs'] = Number(facts['failed runs'] ?? 0) + (rec.heartbeat.runs.failed ?? 0);
      }
      touched = true;
    }
    // A platform, by what it cost on each basis — never added across bases.
    for (const c of rec.pulse?.cost ?? []) {
      if ((c.platform ?? '').toLowerCase() !== key) continue;
      what ||= 'a platform the town reads';
      const micro = (c.days ?? []).reduce((n, d) => n + (d.amountMicroUsd ?? 0), 0);
      const label = `${c.basis ?? 'unlabelled'} cost (USD)`;
      facts[label] = Number(((Number(facts[label] ?? 0) * 1e6 + micro) / 1e6).toFixed(4));
      touched = true;
    }
    if (touched) days.push(day);
  }
  return days.length ? { name, what: what || 'named in the records', facts, days } : null;
}

export interface PulseFacts {
  subjects: PulseNamedThing[];
  /** Names the question mentioned that the records do not know — said, never guessed at. */
  unknown: string[];
  window: { from: string; to: string; words: string };
  daysRead: string[];
  daysMissing: string[];
}

/** Everything an answer to this question may draw on. Pure: the caller does the reading. */
export function factsFor(question: string, window: PulseWindow, found: Array<{ day: string; rec: PulseDayRecord }>): PulseFacts {
  // What the question named outright, PLUS the roots it asked the count of by their kind ("how many people").
  // A kind word is not a name in the records, so it could never be matched by `subjectsNamed` alone.
  const named = [...new Set([...subjectsNamed(question, found), ...rootsAsked(question, rootsIn(found)).map((t) => `.${t}`)])];
  const subjects = named.map((n) => factsAbout(n, found)).filter((x): x is PulseNamedThing => x !== null);
  const known = new Set(subjects.map((s) => s.name));
  const knownNames = namesIn(found);
  // A question that named something we know is answered about that. A question that named NOTHING we know
  // but did name something identifier-shaped is told so — the alternative is answering about the week at
  // someone who asked about a machine, which reads as an answer and is not one.
  const unknown = subjects.length
    ? named.filter((n) => !known.has(n))
    : identifierish(question).filter((t) => !knownNames.has(t));
  return {
    subjects,
    unknown,
    window: { from: window.from, to: window.to, words: window.words },
    daysRead: found.map((f) => f.day),
    daysMissing: window.days.filter((d) => !found.some((f) => f.day === d)),
  };
}

/** One subject, stated. The deterministic fallback, and the shape the composer is given as evidence. */
export function statedSubject(s: PulseNamedThing): string {
  const parts = Object.entries(s.facts).map(([k, v]) => `${k} ${typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v) : v}`);
  return `${s.name} is ${s.what}. ${parts.join('; ')}. Read from ${s.days.length === 1 ? 'the record for' : 'the records for'} ${s.days.join(', ')}.`;
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

  // WHAT THE QUESTION NAMED COMES FIRST. A question about one thing is answered about that thing; the
  // window summary is what you get when nothing in particular was asked about. Reading the week back at
  // someone who asked about one Worker is the failure this fixes.
  const facts = factsFor(question, window, found);
  for (const sub of facts.subjects) parts.push(statedSubject(sub));
  for (const miss of facts.unknown) parts.push(`I have no record of anything called "${miss}" — it is not a service the town probes, a resource a platform reports to it, or an estate on this chain.`);
  if (facts.subjects.length || facts.unknown.length) {
    const missing = window.days.filter((d) => !found.some((f) => f.day === d));
    if (missing.length) parts.push(`${plural(missing.length, 'day')} in the window ${missing.length === 1 ? 'has' : 'have'} no record, so this is partial — never a smaller total.`);
    return { ...head, read: true, answer: parts.join(' ') };
  }

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
      const v = reading(r);
      if (v.ok === false || (v.status && v.status !== 'up')) {
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

  if (subject === 'names' || subject === 'overall') {
    const rs = rootsIn(found);
    const counted = rs.filter((r) => r.count > 0);
    if (!rs.length) { if (subject === 'names') parts.push(`No name count is recorded for ${window.words}.`); }
    else {
      // The total is of the LATEST count per root, and the day each was read on is said: a root the town could
      // not read today still reports the day it was last counted rather than dropping out of the total silently.
      const total = rs.reduce((n, r) => n + r.count, 0);
      const asOf = rs.reduce((a, b) => (a.day > b.day ? a : b)).day;
      const head2 = `The town of names, counted on ${asOf}: ${total.toLocaleString('en-US')} names under ${plural(counted.length, 'ending')}`;
      parts.push(subject === 'names'
        ? `${head2} — ${counted.map((r) => `${r.count.toLocaleString('en-US')} .${r.tld}${r.names ? ` (${r.names})` : ''}`).join(', ')}. A count of names, never of people: no name and no owner is in these records.`
        : `${head2}.`);
    }
  }

  const missing = window.days.filter((d) => !found.some((f) => f.day === d));
  if (missing.length) parts.push(`${plural(missing.length, 'day')} in the window ${missing.length === 1 ? 'has' : 'have'} no record, so this is partial — never a smaller total.`);
  return { ...head, read: true, answer: parts.join(' ') };
}

/**
 * THE EVIDENCE a composed answer may use, and nothing else: the facts retrieved for this question, each
 * item naming where it came from. An open-ended question gets words written over THIS and no world
 * knowledge — which is the only way "tell me about demo-a2a-faithnet" can be both fluent and true.
 */
export function evidenceFor(facts: PulseFacts, found: Array<{ day: string; rec: PulseDayRecord }>, stated: string): Array<{ tool: string; result: unknown }> {
  const items: Array<{ tool: string; result: unknown }> = [];
  for (const sub of facts.subjects) items.push({ tool: `pulse.record.about:${sub.name}`, result: { ...sub, stated: statedSubject(sub) } });
  if (!facts.subjects.length) {
    // No named thing: the window itself is the subject, so the evidence is the day-by-day shape of it.
    items.push({ tool: 'pulse.window.summary', result: { window: facts.window, stated } });
    for (const { day, rec } of found.slice(-3)) {
      items.push({ tool: `pulse.day:${day}`, result: {
        day,
        services: rec.services ?? {},
        runs: rec.heartbeat?.runs ?? null,
        inferenceMicroUsd: rec.heartbeat?.inferenceMicroUsd ?? null,
        cost: (rec.pulse?.cost ?? []).map((c) => ({ platform: c.platform, basis: c.basis, owner: c.owner, microUsd: (c.days ?? []).reduce((n, d) => n + (d.amountMicroUsd ?? 0), 0) })),
        notUp: (rec.pulse?.infrastructure ?? []).map((r) => ({ r, v: reading(r) })).filter(({ v }) => v.ok === false || (v.status && v.status !== 'up')).map(({ r, v }) => ({ resource: r.resource, platform: r.platform, status: v.status, error: v.error })),
        resources: (rec.pulse?.infrastructure ?? []).length,
        unattributed: (rec.pulse?.unattributed ?? []).length,
      } });
    }
  }
  if (facts.unknown.length) items.push({ tool: 'pulse.record.unknown', result: { named: facts.unknown, note: 'the records know nothing by these names' } });
  const roots = rootsIn(found);
  if (roots.length) items.push({ tool: 'pulse.names.roots', result: { roots, total: roots.reduce((n, r) => n + r.count, 0), note: 'a count of NAMES under each root, as of the day given; counts are running totals and are never added across days, and no name or owner is recorded' } });
  if (facts.daysMissing.length) items.push({ tool: 'pulse.window.gaps', result: { missing: facts.daysMissing, note: 'days in the window with no record at all' } });
  return items;
}

/** The rules a composed answer must keep, on top of whatever doctrine the agent's own playbook carries. */
export const COMPOSE_RULES = [
  'Answer ONLY from the evidence below. It is the whole of what you know; you have no other knowledge of this deployment.',
  'If the evidence does not contain the answer, say exactly that and name what would have to have been recorded. Never fill a gap.',
  'A figure absent from the evidence is ABSENT, never zero.',
  'Never add two cost figures that carry different bases (billed, effective, derived) — they measure different things.',
  'Report counts and totals only. There is no person in these records; do not describe one.',
  'Be brief and concrete: what the records say, over which days.',
].join(' ');

/** Compose over the evidence, or return null so the caller states the facts instead. */
async function composed(
  compose: ((input: { intent: { goal: string }; observations: never[]; evidence: Array<{ tool: string; result: unknown }> }) => Promise<string>) | undefined,
  question: string,
  evidence: Array<{ tool: string; result: unknown }>,
): Promise<string | null> {
  if (!compose) return null;
  try {
    const text = await compose({ intent: { goal: question }, observations: [] as never[], evidence });
    const t = (text ?? '').trim();
    return t.length > 0 ? t : null;
  } catch {
    // A composer that failed is not an answer that failed: the facts are still true and still sayable.
    return null;
  }
}

/**
 * The whole capability: read the window's records from the agent's own vault, retrieve what the question
 * names, and answer.
 *
 * TWO WAYS TO SAY IT, ONE SOURCE OF TRUTH. The facts come from the records either way. When the caller
 * supplies a composer (and the question is open-ended), the words are written over those facts under the
 * agent's OWN playbook instructions plus `COMPOSE_RULES` — the doctrine the archetype carries is exactly
 * the rules a fluent answer about money and uptime has to keep. With no composer, or when it fails, the
 * facts are STATED. The second is never silence and never a worse answer, only a plainer one.
 */
export async function publicPulseAsk(
  deps: {
    readSubjectRecord: (subject: string, recordType: string) => Promise<unknown>;
    /** The agent's composer, already carrying its playbook instructions as the system prompt. */
    compose?: (input: { intent: { goal: string }; observations: never[]; evidence: Array<{ tool: string; result: unknown }> }) => Promise<string>;
  },
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
  const facts = factsFor(question, window, found);
  // Nothing was read ⇒ there is nothing to compose over, and the refusal is already the right answer.
  const words = found.length ? await composed(deps.compose, question, evidenceFor(facts, found, a.answer)) : null;
  return { ...a, ...(words ? { answer: words, stated: a.answer, composed: true } : { composed: false }), owner, question, named: facts.subjects.map((x) => x.name), unknown: facts.unknown };
}
