// A ROUTINE FROM A SENTENCE — spec 402 W3. "Every Monday at 8, tell me what's on my calendar and any unanswered mail
// from the elders" → { every: '7d', at: <next Monday 08:00 in the asker's zone>, ask: 'tell me what's on my calendar
// and any unanswered mail from the elders' }. Deterministic (compile, don't interpret — spec 355): the clock words are
// a closed grammar, the rest of the sentence is the ask, verbatim. Anything the grammar does not cover is not guessed:
// the invoker asks. Nothing here is authority — a routine fires as the agent holding nothing; an act parks.
export interface RoutineSentence {
  /** Spec 403 W1 — a REMINDER: fires ONCE at `firstAt`, its words delivered verbatim, then it is gone. `every` is 'once'. */
  once?: true;
  /** Spec 402 W3b — a CONNECTOR trigger: the clock runs a poll; the poll fires the ask only when something new matches. */
  connector?: { connector: 'google-gmail'; query: string } | { connector: 'google-calendar'; leadMinutes: number };
  /** The recurrence as the trigger store keeps it (a duration: 1d, 7d, 1h…). */
  every: string;
  everyMs: number;
  /** The first firing, ms since epoch. */
  firstAt: number;
  /** The words of the clock, as said ("every Monday at 8"). */
  when: string;
  /** What to do each time — the sentence with the clock removed. */
  ask: string;
}

const DAY = 24 * 3600_000;
const MONTHS: Record<string, number> = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

/** "at 8", "at 8am", "at 8:30", "at 17:00", "at noon", "at 8 pm" → minutes after midnight, or null. */
export function timeOfDay(words: string): number | null {
  const s = words.trim().toLowerCase();
  if (s === 'noon' || s === 'midday') return 12 * 60;
  if (s === 'midnight') return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  const ap = (m[3] ?? '').replace(/\./g, '');
  if (h > 23 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  // a bare small hour ("at 8") is the morning; ("at 5") stays 05:00 — the read-back shows the time, so a wrong guess is caught there
  return h * 60 + min;
}

/** The moment (ms) at `minutes` after midnight in `tz`, `daysAhead` days from today (0 = today, even if already past). */
export function atDay(now: number, minutes: number, tz: string, daysAhead: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const probe = now + daysAhead * DAY;
  const parts = Object.fromEntries(fmt.formatToParts(probe).map((p) => [p.type, p.value]));
  const localMinutes = Number(parts.hour) % 24 * 60 + Number(parts.minute);
  return probe - localMinutes * 60_000 - (probe % 60_000) + minutes * 60_000;
}
/** The next `month day` (e.g. Sep 17) at `minutes` in `tz`, strictly after `now` — this year, or next when it has passed. */
export function atDate(now: number, month: number, day: number, minutes: number, tz: string): number | null {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  for (const year of [Number(today.year), Number(today.year) + 1]) {
    // walk from today up to 400 days to find the local date — Intl has no inverse, and a walk is exact across DST
    for (let d = 0; d < 400; d++) {
      const probe = now + d * DAY;
      const parts = Object.fromEntries(fmt.formatToParts(probe).map((p) => [p.type, p.value]));
      if (Number(parts.year) === year && Number(parts.month) === month + 1 && Number(parts.day) === day) {
        const t = atDay(now, minutes, tz, d);
        if (t > now) return t;
      }
    }
  }
  return null;
}

/** The next moment (ms) at `minutes` after midnight in `tz`, on a given weekday when one is named, strictly after `now`. */
export function nextAt(now: number, minutes: number, tz: string, weekday?: number): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  // walk day by day from today (in tz) until the weekday matches and the moment is after now
  for (let d = 0; d < 8; d++) {
    const probe = now + d * DAY;
    const parts = Object.fromEntries(fmt.formatToParts(probe).map((p) => [p.type, p.value]));
    const wd = DAYS[String(parts.weekday).toLowerCase()];
    if (weekday !== undefined && wd !== weekday) continue;
    // the local midnight of that date, found by offsetting from the probe's local time
    const localMinutes = Number(parts.hour) % 24 * 60 + Number(parts.minute);
    const candidate = probe - localMinutes * 60_000 - (probe % 60_000) + minutes * 60_000;
    if (candidate > now) return candidate;
  }
  return now + (weekday !== undefined ? 7 : 1) * DAY;
}

/**
 * Parse the sentence. Grammar (case-insensitive, the clock may lead or trail):
 *   every (day|morning|evening|week|hour|N hours|N days|<weekday>|weekday) [at <time>] , <ask>
 *   <ask> every … [at <time>]
 *   daily|weekly|hourly … / each <weekday> …
 */
export function parseRoutineSentence(sentence: string, opts: { now?: number; tz?: string } = {}): RoutineSentence | { error: string } {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? 'UTC';
  const text = sentence.trim().replace(/\s+/g, ' ');
  // ── Spec 402 W3b — CONNECTOR triggers, first: "when mail arrives from the pastor, …", "when an email about the
  //    retreat comes in, …", "15 minutes before a calendar event, …". The clock is the poll's; the match is the source's.
  const mail = /\b(?:when(?:ever)?|each time|every time)\s+(?:an?\s+)?(?:new\s+)?(?:mail|email|e-mail|message)s?\s+(?:arrives?|comes?(?: in)?|lands?|shows? up)(?:\s+from\s+(.+?))?(?:\s+about\s+(.+?))?(?=[,;:—-]|\s+(?:then|please)\b|$)/i.exec(text);
  if (mail) {
    // "from the pastor" → from:pastor (an article is not a name; a name with spaces is joined, Gmail matches on either part);
    // "about the retreat" → the words, articles dropped.
    const strip = (v: string) => v.replace(/^(the|a|an|my|our)\s+/i, '').trim();
    const from = strip(mail[1] ?? ''); const about = strip(mail[2] ?? '');
    const query = [from ? `from:${from.replace(/\s+/g, '')}` : '', about, 'newer_than:2d'].filter(Boolean).join(' ');
    const ask = text.replace(mail[0], '').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').replace(/^(then|please)\s+/i, '').replace(/^(tell me|let me know|send me|message me|remind me of|remind me|show me|give me)\s+/i, '').trim();
    if (ask.length < 3) return { error: 'say what to do when it arrives — "summarize it", "draft a reply", "tell me who wrote"' };
    return { connector: { connector: 'google-gmail', query }, every: '15m', everyMs: 15 * 60_000, firstAt: now + 15 * 60_000, when: mail[0].trim(), ask };
  }
  const lead = /\b(?:(\d+)\s*(?:minutes?|mins?|hours?|h)\s+)?before\s+(?:each|every|an?|my|the next)\s+(?:calendar\s+)?(?:event|meeting|appointment)s?\b/i.exec(text);
  if (lead) {
    const n = Number(lead[1] ?? 15); const isHours = /hour|h\b/i.test(lead[0].split('before')[0] ?? '');
    const leadMinutes = Math.min(Math.max(isHours ? n * 60 : n, 5), 24 * 60);
    const ask = text.replace(lead[0], '').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').replace(/^(then|please)\s+/i, '').replace(/^(tell me|let me know|send me|message me|remind me of|remind me|show me|give me)\s+/i, '').trim();
    if (ask.length < 3) return { error: 'say what to do before the event — "tell me who is coming", "summarize the last mail from the organizer"' };
    return { connector: { connector: 'google-calendar', leadMinutes }, every: '5m', everyMs: 5 * 60_000, firstAt: now + 5 * 60_000, when: lead[0].trim(), ask };
  }
  // ── Spec 403 W1 — a REMINDER, once: "remind me tomorrow at 3 to call the pastor", "in 20 minutes tell me to check the
  //    oven", "on Thursday at 7pm …", "on Sep 17 at noon …", "tonight …", "at 5 today …". One moment, never a cadence;
  //    the words are hers, read back to her at the hour.
  const once = parseOnce(text, now, tz);
  if (once) return once;
  const clock = /\b(?:(every|each)\s+(day|morning|evening|week|hour|weekday|(\d+)\s+(hours?|days?|weeks?|minutes?)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)|(daily|weekly|hourly))(?:\s+at\s+((?:\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)|noon|midday|midnight))?\b/i;
  const m = clock.exec(text);
  if (!m) return { error: /^(?:remind me|nudge me|ping me)\b/i.test(text) ? 'say when — "tomorrow at 3", "in 20 minutes", "on Thursday at 7pm", "on Sep 17 at noon"' : 'say when — "every day at 8", "every Monday at 8:30", "every 2 hours", "weekly"' };
  const unit = (m[2] ?? m[5] ?? '').toLowerCase();
  const n = m[3] ? Number(m[3]) : 1;
  const nUnit = (m[4] ?? '').toLowerCase();
  const at = m[6] ? timeOfDay(m[6]) : null;
  if (m[6] && at === null) return { error: `I could not read the time "${m[6]}" — say it like "8am", "8:30", "17:00" or "noon"` };
  let everyMs: number; let every: string; let weekday: number | undefined; let minutes = at ?? 8 * 60;
  if (nUnit) {
    const ms = nUnit.startsWith('hour') ? 3600_000 : nUnit.startsWith('minute') ? 60_000 : nUnit.startsWith('week') ? 7 * DAY : DAY;
    if (n < 1) return { error: 'the interval must be at least 1' };
    everyMs = n * ms; every = `${n * (nUnit.startsWith('week') ? 7 : 1)}${nUnit.startsWith('hour') ? 'h' : nUnit.startsWith('minute') ? 'm' : 'd'}`;
    if (everyMs < 15 * 60_000) return { error: 'a routine fires at most every 15 minutes' };
  } else if (unit === 'hour' || unit === 'hourly') { everyMs = 3600_000; every = '1h'; }
  else if (unit === 'week' || unit === 'weekly') { everyMs = 7 * DAY; every = '7d'; }
  else if (unit in DAYS) { everyMs = 7 * DAY; every = '7d'; weekday = DAYS[unit]; }
  else if (unit === 'weekday') { everyMs = DAY; every = '1d'; }
  else { everyMs = DAY; every = '1d'; if (unit === 'evening' && at === null) minutes = 18 * 60; }
  const firstAt = everyMs >= DAY ? nextAt(now, minutes, tz, weekday) : now + everyMs;
  // The ask, as her agent will ask it of itself. "Tell me / let me know / send me / remind me" is the routine's OWN
  // behaviour — every answer is delivered to her — so those words come off and what remains is the question; kept
  // whole they read as an instruction to message someone, which a lookup-only plan is refused for (spec 367 W1).
  const ask = text.replace(m[0], '').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').replace(/^(then|please)\s+/i, '').replace(/^(tell me|let me know|send me|message me|remind me of|remind me|show me|give me)\s+/i, '').trim();
  if (ask.length < 3) return { error: 'say what to do each time — "tell me what is on my calendar", "check for mail from the elders"' };
  return { every, everyMs, firstAt, when: m[0].trim(), ask };
}

const TIME_RE = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?|noon|midday|midnight)';
const WEEKDAY_RE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)';
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
/** A reminder's bare small hour ("at 3", "tomorrow at 5") is the afternoon: nobody sets a reminder for 3 AM without saying so. */
const onceTime = (words: string): number | null => { const t = timeOfDay(words); if (t === null) return null; const bare = /^\d{1,2}(?::\d{2})?$/.test(words.trim()); const h = Math.floor(t / 60); return bare && h >= 1 && h <= 6 ? t + 12 * 60 : t; };
const STRIP_VERB = /^(?:to\s+)?(?:remind me(?: to| that| about)?|tell me(?: to| that)?|let me know(?: to| that)?|nudge me(?: to)?|ping me(?: to)?)\s+/i;

/** Spec 403 W1 — the one-shot clock, or null when the sentence has none. Exported for the compile chain. */
export function parseOnce(text: string, now: number, tz: string): RoutineSentence | null {
  // a sentence with a cadence is never a reminder
  if (/\b(every|each)\b|\b(daily|weekly|hourly)\b/i.test(text)) return null;
  const at = `(?:\\s+at\\s+(${TIME_RE}))?`;
  const forms: Array<{ re: RegExp; when: (m: RegExpExecArray) => { at: number; label: string } | { error: string } | null }> = [
    { re: new RegExp(`\\bin\\s+(\\d+)\\s*(minutes?|mins?|hours?|hrs?|h|days?)\\b`, 'i'), when: (m) => { const n = Number(m[1]); const u = m[2]!.toLowerCase(); const ms = u.startsWith('d') ? DAY : u.startsWith('h') ? 3600_000 : 60_000; if (n < 1) return { error: 'the wait must be at least 1' }; if (ms === 60_000 && n < 1) return null; return { at: now + n * ms, label: m[0] }; } },
    { re: new RegExp(`\\b(tomorrow|today|tonight|this evening|this afternoon|this morning)${at}\\b`, 'i'), when: (m) => { const w = m[1]!.toLowerCase(); const t = m[2] ? onceTime(m[2]) : null; if (m[2] && t === null) return { error: `I could not read the time "${m[2]}"` }; const minutes = t ?? (w === 'tonight' || w === 'this evening' ? 19 * 60 : w === 'this afternoon' ? 15 * 60 : w === 'this morning' ? 9 * 60 : 9 * 60); const at_ = atDay(now, minutes, tz, w === 'tomorrow' ? 1 : 0); return at_ > now ? { at: at_, label: m[0] } : { error: `${w} at that time has already passed` }; } },
    { re: new RegExp(`\\b(?:on\\s+|next\\s+|this\\s+)?(${WEEKDAY_RE})${at}\\b`, 'i'), when: (m) => { const t = m[2] ? onceTime(m[2]) : null; if (m[2] && t === null) return { error: `I could not read the time "${m[2]}"` }; return { at: nextAt(now, t ?? 9 * 60, tz, DAYS[m[1]!.toLowerCase()]), label: m[0] }; } },
    { re: new RegExp(`\\b(?:on\\s+)?(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?${at}\\b`, 'i'), when: (m) => { const t = m[3] ? onceTime(m[3]) : null; if (m[3] && t === null) return { error: `I could not read the time "${m[3]}"` }; const month = MONTHS[m[1]!.toLowerCase()]; const day = Number(m[2]); if (month === undefined || day < 1 || day > 31) return null; const at_ = atDate(now, month, day, t ?? 9 * 60, tz); return at_ ? { at: at_, label: m[0] } : { error: `there is no ${m[1]} ${day}` }; } },
    { re: new RegExp(`\\bat\\s+(${TIME_RE})\\b`, 'i'), when: (m) => { const t = onceTime(m[1]!); if (t === null) return { error: `I could not read the time "${m[1]}"` }; const today = atDay(now, t, tz, 0); return { at: today > now ? today : atDay(now, t, tz, 1), label: m[0] }; } },
  ];
  // only a sentence that is SAID as a reminder, or carries a one-shot clock with a reminder verb, is one
  const reminderish = /^(?:remind me|nudge me|ping me)\b/i.test(text) || /\b(remind me|tell me|let me know|nudge me|ping me)\b/i.test(text);
  if (!reminderish) return null;
  for (const f of forms) {
    const m = f.re.exec(text);
    if (!m) continue;
    const w = f.when(m);
    if (!w) continue;
    if ('error' in w) return { error: w.error } as never;
    const ask = text.replace(m[0], ' ').replace(/\s+/g, ' ').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').replace(/^(then|please)\s+/i, '').replace(STRIP_VERB, '').replace(/^(?:to\s+)/i, '').trim();
    if (ask.length < 2) return { error: 'say what to remind you of — "remind me tomorrow at 3 to call the pastor"' } as never;
    return { once: true, every: 'once', everyMs: 0, firstAt: w.at, when: w.label.trim(), ask };
  }
  return null;
}

/** The read-back: what will happen, when first, how often — in words, with the asker's zone. */
export function routineWords(r: RoutineSentence, tz: string): string {
  if (r.once) return `once, ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(r.firstAt)} (${tz}): "${r.ask}"`;
  if (r.connector?.connector === 'google-gmail') return `whenever mail matching "${r.connector.query.replace(/ newer_than:\S+/, '')}" arrives (your mail is checked every 15 minutes): "${r.ask}"`;
  if (r.connector?.connector === 'google-calendar') return `${r.connector.leadMinutes} minutes before each calendar event (your calendar is checked every 5 minutes): "${r.ask}"`;
  const first = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(r.firstAt);
  const cadence = r.every === '1d' ? 'every day' : r.every === '7d' ? 'every week' : r.every === '1h' ? 'every hour' : `every ${r.every.replace(/(\d+)([hdm])/, (_, a, u) => `${a} ${u === 'h' ? 'hour' : u === 'm' ? 'minute' : 'day'}${a === '1' ? '' : 's'}`)}`;
  return `${cadence}, starting ${first} (${tz}): "${r.ask}"`;
}
