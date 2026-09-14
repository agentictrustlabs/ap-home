// ROUTINES FROM A SENTENCE — spec 402 W3. "Every Monday at 8, tell me what's on my calendar and any unanswered mail
// from the elders." The sentence is compiled (routine-sentence.ts), READ BACK as one card — what, how often, when first,
// in the person's zone — and kept only from her supplied yes (the 385/394 trusted-event rule: a planner's reading of
// "every Monday" writes nothing). What is kept is a schedule row of her own on her agent's object (`declared`), beside
// the playbook's; each firing is an unattended run as her agent holding nothing — a read answers and the answer is
// delivered to her; an act parks for her mandate, fresh each time. Removing it is hers too. Nothing here is authority.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { parseRoutineSentence, routineWords } from './routine-sentence.js';
import type { TriggerScheduleV1 } from './triggers.js';

export const ROUTINE_DECLARE = 'person.routine.declare' as const;
export const ROUTINE_LIST = 'person.routine.list' as const;
export const ROUTINE_REMOVE = 'person.routine.remove' as const;

export const ROUTINE_TOOLS: ToolSpec[] = [
  {
    id: ROUTINE_DECLARE,
    verbs: ['every day', 'every morning', 'every evening', 'every week', 'every monday', 'every tuesday', 'every wednesday', 'every thursday', 'every friday', 'every saturday', 'every sunday', 'every hour', 'daily', 'weekly', 'each day', 'each week', 'on a schedule'],
    description:
      'KEEPS A ROUTINE of the person\'s own from a sentence with a clock in it — "every Monday at 8, tell me what\'s on my calendar", "every evening summarize my '
      + 'unread mail", "every 2 hours check for mail from the pastor". Args: sentence (the whole ask, clock included). It is read back before it is kept; each '
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
}

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
        return { count: mine.length, routines: mine.map((r) => ({ id: r.triggerId, name: r.declared?.name, when: r.declared?.when, every: r.every, ask: r.ask, nextAt: r.nextAt ? new Date(r.nextAt).toISOString() : null, paused: !!r.paused, last: r.lastOutcome ? { outcome: r.lastOutcome, at: r.lastAt ? new Date(r.lastAt).toISOString() : null, said: r.lastSaid } : null })), answer: mine.length ? mine.map((r) => `— ${r.declared?.when ?? r.every}: ${r.ask}${r.nextAt ? ` (next ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(r.nextAt)})` : ''}${r.paused ? ' — paused' : ''}`).join('\n') : 'You have no routines yet — say "every Monday at 8, tell me what\'s on my calendar".' };
      case ROUTINE_REMOVE: {
        const id = typeof args.id === 'string' ? args.id : '';
        const words = String(args.words ?? '').trim().toLowerCase();
        const target = id ? mine.find((r) => r.triggerId === id) : words ? mine.find((r) => r.ask.toLowerCase().includes(words) || (r.declared?.saidAs ?? '').toLowerCase().includes(words)) : undefined;
        if (!target) return { removed: false, refused: id ? `no routine of yours has the id ${id}` : words ? `none of your routines mentions "${words}"` : 'say which routine — its id, or words it contains', count: mine.length };
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
          return ask({ kind: 'data', stepRef, toolId, prompt: `I will do this ${words}. Each time it runs as your agent: a read is answered to you here; anything that acts waits for your signature. Keep this routine?`, fields: [{ name: 'keep', label: 'keep it', type: 'choice', required: true, choices: [{ value: 'yes', label: 'Yes, keep it' }, { value: 'no', label: 'No' }] }] });
        }
        if (answer !== 'yes') return { kept: false, note: 'nothing was kept' };
        const triggerId = `routine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : undefined;
        const row: TriggerScheduleV1 = { agent: me as `0x${string}`, triggerId, kind: 'schedule', ask: parsed.ask, every: parsed.every, everyMs: parsed.everyMs, nextAt: parsed.firstAt, playbookDigest: 'declared', declared: { by: me, at: Date.now(), saidAs: sentence, when: parsed.when, tz, ...(name ? { name } : {}) } };
        const kept = await deps.declareTrigger(me, row);
        return { kept: true, id: kept.triggerId, ask: parsed.ask, every: parsed.every, when: parsed.when, firstAt: new Date(parsed.firstAt).toISOString(), tz, words, note: 'your own routine, on your agent\'s clock — it fires as your agent holding nothing; pause or remove it on Routines' };
      }
      default: throw new Error(`${toolId} is not a routine capability`);
    }
  };
}

/** A sentence with a clock in it, said at the person's own agent, is a routine — compiled, never interpreted. */
export function compiledRoutine(goal: string): { steps: Array<{ toolId: string; args: Record<string, unknown> }>; rationale: string } | null {
  const g = goal.trim();
  if (!/\b(every|each)\s+(day|morning|evening|week|hour|weekday|\d+\s+(hours?|days?|weeks?|minutes?)|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(daily|weekly|hourly)\b/i.test(g)) return null;
  // not a routine: "what do I have every Monday" is a question about the calendar; "remember that every Monday …" is memory
  if (/^(what|which|when|who|do i|is there|how many)\b/i.test(g) || /^remember\b/i.test(g)) return null;
  return { steps: [{ toolId: ROUTINE_DECLARE, args: { sentence: g } }], rationale: 'compiled: a sentence with a clock is a routine (spec 402 W3)' };
}
