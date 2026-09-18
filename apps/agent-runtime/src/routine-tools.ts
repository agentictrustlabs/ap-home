// ROUTINES FROM A SENTENCE — spec 402 W3. "Every Monday at 8, tell me what's on my calendar and any unanswered mail
// from the elders." The sentence is compiled (routine-sentence.ts), READ BACK as one card — what, how often, when first,
// in the person's zone — and kept only from her supplied yes (the 385/394 trusted-event rule: a planner's reading of
// "every Monday" writes nothing). What is kept is a schedule row of her own on her agent's object (`declared`), beside
// the playbook's; each firing is an unattended run as her agent holding nothing — a read answers and the answer is
// delivered to her; an act parks for her mandate, fresh each time. Removing it is hers too. Nothing here is authority.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { routinesOf, keepRoutine, dropRoutine, ROUTINES_RECORD, type DeclaredRoutineV1 } from '@agenticprimitives/context';
import { parseRoutineSentence, routineWords } from './routine-sentence.js';
import { requirePersonsTurn } from './persons-turn.js';
import type { TriggerScheduleV1 } from './triggers.js';

export const ROUTINE_DECLARE = 'person.routine.declare' as const;
export const ROUTINE_LIST = 'person.routine.list' as const;
export const ROUTINE_REMOVE = 'person.routine.remove' as const;

export const ROUTINE_TOOLS: ToolSpec[] = [
  {
    id: ROUTINE_DECLARE,
    verbs: ['remind me', 'remind me tomorrow', 'remind me at', 'in an hour remind me', 'every day', 'every morning', 'every evening', 'every week', 'every monday', 'every tuesday', 'every wednesday', 'every thursday', 'every friday', 'every saturday', 'every sunday', 'every hour', 'daily', 'weekly', 'each day', 'each week', 'on a schedule', 'when mail arrives', 'whenever an email arrives', 'before each meeting', 'before every event'],
    description:
      'KEEPS A ROUTINE of the person\'s own from a sentence with a clock in it — "every Monday at 8, tell me what\'s on my calendar", "every evening summarize my '
      + 'unread mail" — or a REMINDER, once: "remind me tomorrow at 3 to call the pastor", "in 20 minutes tell me to check the oven" (delivered at the hour, then gone) — '
      + 'unread mail" — or a SOURCE in it: "when mail arrives from the pastor, summarize it", "15 minutes before each meeting, tell me who is coming" (the clock '
      + 'polls the source; only something new fires the ask). Args: sentence (the whole ask, clock or source included). It is read back before it is kept; each '
      + 'firing runs as her agent holding nothing — a read answers and is delivered to her, an act parks for her mandate. It authorizes nothing.',
    inputSchema: { type: 'object', properties: { sentence: { type: 'string', description: 'The whole sentence, clock and all' }, name: { type: 'string', description: 'A short name (optional)' } }, required: ['sentence'] },
    capability: { id: ROUTINE_DECLARE, action: 'declare', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low',
    selfAuthorized: true,
    interaction: { navigationTarget: 'routines' },
  },
  {
    id: ROUTINE_LIST,
    answers: ['what routines do I have', 'my routines', 'what do you do on a schedule', 'what runs every day'],
    description: 'ANSWERS the routines the person declared — each with when it next fires, how often, and what its last firing reached. Only for the person asking.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
    interaction: { navigationTarget: 'routines' },
  },
  {
    id: ROUTINE_REMOVE,
    verbs: ['stop the routine', 'remove the routine', 'stop doing that every', 'cancel the routine'],
    description: 'REMOVES one routine the person declared — by id (from person.routine.list) or by words it contains. A playbook\'s routine cannot be removed this way.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, words: { type: 'string' } } },
    capability: { id: ROUTINE_REMOVE, action: 'remove', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low',
    selfAuthorized: true,
    interaction: { navigationTarget: 'routines' },
  },
];
export const ROUTINE_ACTS = new Set<string>([ROUTINE_DECLARE, ROUTINE_REMOVE]);

export interface RoutineDeps {
  listTriggers?: (agent: string) => Promise<TriggerScheduleV1[]>;
  declareTrigger?: (agent: string, row: TriggerScheduleV1) => Promise<TriggerScheduleV1>;
  removeTrigger?: (agent: string, triggerId: string) => Promise<void>;
  /** Spec 323 W6 — the RECORD (`routines.data` in her vault); the row on her agent's object is its projection. */
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
}

/** The record entry for a schedule row — what she declared, without the serving-plane state (clock, seen, pause). */
export const routineEntryOf = (row: TriggerScheduleV1): DeclaredRoutineV1 | null => row.declared && row.every && typeof row.everyMs === 'number'
  ? { triggerId: row.triggerId, kind: row.kind === 'connector' ? 'connector' : row.kind === 'once' ? 'once' : 'schedule', ...(row.kind === 'once' && typeof row.nextAt === 'number' ? { at: row.nextAt } : {}), ...(row.on ? { on: row.on as DeclaredRoutineV1['on'] } : {}), ask: row.ask, every: row.every, everyMs: row.everyMs, declared: { by: row.declared.by, at: row.declared.at, saidAs: row.declared.saidAs, when: row.declared.when, tz: row.declared.tz, ...(row.declared.name ? { name: row.declared.name } : {}) } }
  : null;

/** The person's zone, from the ask's context when the surface said it; UTC otherwise (the read-back names it). */
const zoneOf = (ctx: { intent: unknown }): string => { const c = (ctx.intent as { context?: { tz?: unknown } }).context; return typeof c?.tz === 'string' && c.tz ? c.tz : 'UTC'; };

export function routineInvoker(deps: RoutineDeps, person: string | undefined, addressee: string | undefined, ask: (input: { kind: 'data'; stepRef: string; toolId: string; prompt: string; fields: Array<{ name: string; label: string; type: 'choice' | 'text'; required: boolean; choices?: Array<{ value: string; label: string }>; hint?: string }> }) => never, supplied: (ctx: unknown, stepRef: string) => Record<string, unknown>): ToolInvoker {
  return async (toolId, args, ctx) => {
    const stepRef = ctx.step.id ?? `s${ctx.index}`;
    if (!person) throw new Error('a routine is kept as you, and there is no signed-in person on this run');
    if (addressee && addressee.toLowerCase() !== person.toLowerCase()) return { refused: 'a routine of your own is kept at your own agent — ask at your home, not in this room' };
    if (!deps.listTriggers || !deps.declareTrigger || !deps.removeTrigger) throw new Error('routines are not reachable from this agent');
    const me = person.toLowerCase();
    const mine = (await deps.listTriggers(me)).filter((r) => r.declared);
    const tz = zoneOf(ctx);
    switch (toolId) {
      case ROUTINE_LIST:
        return { count: mine.length, routines: mine.map((r) => ({ id: r.triggerId, name: r.declared?.name, when: r.declared?.when, every: r.every, once: r.kind === 'once', ask: r.ask, nextAt: r.nextAt ? new Date(r.nextAt).toISOString() : null, paused: !!r.paused, last: r.lastOutcome ? { outcome: r.lastOutcome, at: r.lastAt ? new Date(r.lastAt).toISOString() : null, said: r.lastSaid } : null })), answer: mine.length ? mine.map((r) => `— ${r.declared?.when ?? r.every}: ${r.ask}${r.nextAt ? ` (next ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(r.nextAt)})` : ''}${r.paused ? ' — paused' : ''}`).join('\n') : 'You have no routines yet — say "every Monday at 8, tell me what\'s on my calendar".' };
      case ROUTINE_REMOVE: {
        // Spec 409 §4 (R917-H-5): a routine is removed on the PERSON'S turn, by words she used or by id after a read-back.
        requirePersonsTurn({ ctx, toolId, what: 'remove a routine', ...(typeof args.words === 'string' && args.words.trim() ? { saidWords: args.words } : {}) });
        const id = typeof args.id === 'string' ? args.id : '';
        const words = String(args.words ?? '').trim().toLowerCase();
        const target = id ? mine.find((r) => r.triggerId === id) : words ? mine.find((r) => r.ask.toLowerCase().includes(words) || (r.declared?.saidAs ?? '').toLowerCase().includes(words)) : undefined;
        if (!target) return { removed: false, refused: id ? `no routine of yours has the id ${id}` : words ? `none of your routines mentions "${words}"` : 'say which routine — its id, or words it contains', count: mine.length };
        // THE RECORD FIRST (spec 323 W6): a routine removed at one Home is gone at every Home because the vault says so.
        await writeRecord(deps, me, (prev) => dropRoutine(prev, target.triggerId));
        await deps.removeTrigger(me, target.triggerId);
        return { removed: true, id: target.triggerId, ask: target.ask, count: mine.length - 1 };
      }
      case ROUTINE_DECLARE: {
        const sentence = String(args.sentence ?? (ctx.intent as { goal?: string }).goal ?? '').trim();
        const parsed = parseRoutineSentence(sentence, { tz });
        if ('error' in parsed) {
          return ask({ kind: 'data', stepRef, toolId, prompt: `${parsed.error}. Say the whole routine again, clock and all.`, fields: [{ name: 'sentence', label: 'the routine', type: 'text', required: true, hint: 'every Monday at 8, tell me what is on my calendar' }] });
        }
        const words = routineWords(parsed, tz);
        const sup = supplied(ctx, stepRef);
        const answer = String(sup.keep ?? '').trim().toLowerCase();
        if (!answer) {
          return ask({ kind: 'data', stepRef, toolId, prompt: parsed.once ? `I will remind you ${words.replace(/^once, /, '')} — a note from your agent in your Messages${'' /* and, when she allows it, her email (spec 403 W2) */}. Keep this reminder?` : `I will do this ${words}. Each time it runs as your agent: a read is answered to you here; anything that acts waits for your signature. Keep this routine?`, fields: [{ name: 'keep', label: 'keep it', type: 'choice', required: true, choices: [{ value: 'yes', label: 'Yes, keep it' }, { value: 'no', label: 'No' }] }] });
        }
        if (answer !== 'yes') return { kept: false, note: 'nothing was kept' };
        const triggerId = `routine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : undefined;
        const row: TriggerScheduleV1 = { agent: me as `0x${string}`, triggerId, kind: parsed.once ? 'once' : parsed.connector ? 'connector' : 'schedule', ...(parsed.connector ? { on: { ...parsed.connector }, seen: [] } : {}), ask: parsed.ask, every: parsed.every, everyMs: parsed.everyMs, nextAt: parsed.firstAt, playbookDigest: 'declared', declared: { by: me, at: Date.now(), saidAs: sentence, when: parsed.when, tz, ...(name ? { name } : {}) } };
        // THE RECORD FIRST (spec 323 W6): her vault holds what she declared; the row on her agent's object is the
        // projection the alarm runs — rebuilt from the record at any deployment. A record that cannot be written is not
        // papered over with a row that would be lost with the object.
        await writeRecord(deps, me, (prev) => keepRoutine(prev, routineEntryOf(row)!));
        const kept = await deps.declareTrigger(me, row);
        return { kept: true, id: kept.triggerId, ask: parsed.ask, every: parsed.every, when: parsed.when, firstAt: new Date(parsed.firstAt).toISOString(), tz, words, ...(parsed.once ? { once: true } : {}), note: parsed.once ? 'a reminder of your own — your agent will tell you at the hour, then it is gone; remove it on Routines before then' : 'your own routine, on your agent\'s clock — it fires as your agent holding nothing; pause or remove it on Routines' };
      }
      default: throw new Error(`${toolId} is not a routine capability`);
    }
  };
}

/** Read-modify-write the person's `routines.data`. Says, when the grant predates the scope, what to do about it. */
async function writeRecord(deps: RoutineDeps, me: string, change: (prev: ReturnType<typeof routinesOf>) => ReturnType<typeof routinesOf>): Promise<void> {
  if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('routines cannot be kept as a record here (the private tier is not configured)');
  const prev = routinesOf(await deps.readSubjectRecord(me, ROUTINES_RECORD).catch(() => null));
  const wrote = await deps.writeSubjectRecord(me, ROUTINES_RECORD, change(prev));
  if (!wrote.ok) throw new Error(/record_scope_denied|scope/i.test(wrote.error ?? '') ? 'your storage grant predates routines — refresh the grant on Today (What your agent knows about you → Refresh the grant), then say it again' : (wrote.error ?? 'the routine could not be kept as a record'));
}

/** A sentence with a clock in it, said at the person's own agent, is a routine — compiled, never interpreted. */
export function compiledRoutine(goal: string): { steps: Array<{ toolId: string; args: Record<string, unknown> }>; rationale: string } | null {
  const g = goal.trim();
  const clocked = /\b(every|each)\s+(day|morning|evening|week|hour|weekday|\d+\s+(hours?|days?|weeks?|minutes?)|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(daily|weekly|hourly)\b/i.test(g);
  // Spec 402 W3b — a CONNECTOR trigger: "when mail arrives from …", "15 minutes before each meeting …"
  const sourced = /\b(when(?:ever)?|each time|every time)\s+(?:an?\s+)?(?:new\s+)?(?:mail|email|e-mail|message)s?\s+(?:arrives?|comes?|lands?|shows? up)\b/i.test(g) || /\bbefore\s+(?:each|every|an?|my|the next)\s+(?:calendar\s+)?(?:event|meeting|appointment)s?\b/i.test(g);
  // Spec 403 W1 — a REMINDER: said as one ("remind me …"), or a tell-me with a one-shot clock ("in 20 minutes tell me …")
  const reminder = /^(?:remind me|nudge me|ping me)\b/i.test(g) || (/\b(tell me|let me know)\b/i.test(g) && /\b(tomorrow|tonight|this (?:evening|afternoon|morning)|in \d+ ?(?:minutes?|mins?|hours?|hrs?|days?)|(?:on|next) (?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\w*|(?:on )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{1,2})\b/i.test(g));
  if (!clocked && !sourced && !reminder) return null;
  // not a routine: "what do I have every Monday" is a question about the calendar; "remember that every Monday …" is memory
  if (/^(what|which|when|who|do i|is there|how many)\b/i.test(g) || /^remember\b/i.test(g)) return null;
  return { steps: [{ toolId: ROUTINE_DECLARE, args: { sentence: g } }], rationale: reminder && !clocked ? 'compiled: a reminder is a routine that fires once (spec 403 W1)' : 'compiled: a sentence with a clock is a routine (spec 402 W3)' };
}
