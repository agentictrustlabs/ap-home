// HER PREFERENCES AS A CAPABILITY — spec 403 W2/W4. "Answer me briefly", "call me Ali", "answer in Spanish", "stop
// emailing me", "email me my routines' answers": a self-acting act at her own agent that changes one record of hers
// (`person.preferences`). Refused in a room (an organization's agent keeps no preferences of hers). Never authority.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { preferencesOf, setPreferences, PREFERENCES_RECORD } from '@agenticprimitives/context';
import { requirePersonsTurn } from './persons-turn.js';
import { ADAPTER, CARRIES } from './adapter-declarations.js';

export const PREFERENCES_SET = 'person.preferences.set' as const;
export const PREFERENCES_GET = 'person.preferences.get' as const;

export const PREFERENCES_TOOLS: ToolSpec[] = [
  {
    id: PREFERENCES_SET,
    verbs: ['answer me briefly', 'answer briefly', 'give me full answers', 'call me', 'answer in', 'reply in', 'stop emailing me', 'do not email me', 'email me when', 'email me my routines', 'send me routine answers by email'],
    description: 'SETS how the person\'s own agent answers and reaches her: style ("brief" | "full"), language (a language name), callMe (what to call her), emailNudges (may it email her reminders and acts waiting for her signature — default yes), routineEmails (email routine answers too — default no). Only the fields she named change; a field set to the word "clear" is cleared. Hers alone; authorizes nothing.',
    inputSchema: { type: 'object', properties: { style: { type: 'string', enum: ['brief', 'full', 'clear'] }, language: { type: 'string' }, callMe: { type: 'string' }, emailNudges: { type: 'string', description: 'yes | no' }, routineEmails: { type: 'string', description: 'yes | no' } } },
    capability: { id: PREFERENCES_SET, action: 'set', resourceArg: 'record', authorityArg: 'holder' },
    risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.preferences,
    selfAuthorized: true,
    interaction: { navigationTarget: 'settings' },
  },
  {
    id: PREFERENCES_GET,
    answers: ['how do you answer me', 'what do you call me', 'do you email me', 'my preferences'],
    description: 'ANSWERS the person\'s own preferences — answer style, language, what her agent calls her, whether it may email her. Only for the person asking.',
    inputSchema: { type: 'object', properties: {} },
    establishes: 'lookup',
    interaction: { navigationTarget: 'settings' },
  },
];
export const PREFERENCES_ACTS = new Set<string>([PREFERENCES_SET]);

export interface PreferencesDeps {
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown, operationId?: string) => Promise<{ ok: boolean; error?: string }>;
}

export function preferencesInvoker(deps: PreferencesDeps, person: string | undefined, addressee: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    if (!person) throw new Error('preferences are kept as you, and there is no signed-in person on this run');
    if (addressee && addressee.toLowerCase() !== person.toLowerCase()) return { refused: 'your preferences are kept by your own agent only — ask at your home, not in this room' };
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('preferences cannot be kept here (the private tier is not configured)');
    const me = person.toLowerCase();
    const prev = preferencesOf(await deps.readSubjectRecord(me, PREFERENCES_RECORD).catch(() => null));
    const words = (p: ReturnType<typeof preferencesOf>) => {
      const a = p.answer ?? {}; const n = p.notify ?? {};
      return [a.style ? `answers ${a.style === 'brief' ? 'briefly' : 'in full'}` : 'answers at the length the question needs', a.language ? `in ${a.language}` : '', a.callMe ? `calls you "${a.callMe}"` : '', n.email === false ? 'never emails you' : `emails you reminders and acts waiting for your signature${n.routines ? ', and routine answers' : ''}`].filter(Boolean).join(' · ');
    };
    if (toolId === PREFERENCES_GET) return { tier: 'private', record: PREFERENCES_RECORD, preferences: prev, answer: `Your agent ${words(prev)}.` };
    if (toolId !== PREFERENCES_SET) throw new Error(`${toolId} is not a preferences capability`);
    const clear = (v: unknown) => typeof v === 'string' && v.trim().toLowerCase() === 'clear';
    const yesNo = (v: unknown): boolean | undefined => typeof v === 'boolean' ? v : typeof v === 'string' ? (/^(yes|on|true|allow|allowed)$/i.test(v.trim()) ? true : /^(no|off|false|stop|never)$/i.test(v.trim()) ? false : undefined) : undefined;
    const change = {
      answer: { ...(args.style !== undefined ? { style: clear(args.style) ? null : (args.style as 'brief' | 'full') } : {}), ...(args.language !== undefined ? { language: clear(args.language) ? null : String(args.language) } : {}), ...(args.callMe !== undefined ? { callMe: clear(args.callMe) ? null : String(args.callMe) } : {}) },
      notify: { ...(yesNo(args.emailNudges) !== undefined ? { email: yesNo(args.emailNudges)! } : {}), ...(yesNo(args.routineEmails) !== undefined ? { routines: yesNo(args.routineEmails)! } : {}) },
    };
    // Spec 409 §4 (R917-H-5): a preference changes on the PERSON'S turn — `emailNudges: no` from a fired run or after a
    // page was read would silence the signature nudges she relies on. Parked with a read-back otherwise.
    requirePersonsTurn({ ctx, toolId, what: `change your preferences (${Object.keys({ ...change.answer, ...change.notify }).join(', ')})` });
    if (!Object.keys(change.answer).length && !Object.keys(change.notify).length) return { changed: false, refused: 'say what to change — "answer me briefly", "call me Ali", "answer in Spanish", "stop emailing me"', preferences: prev };
    const next = setPreferences(prev, change);
    const wrote = await deps.writeSubjectRecord(me, PREFERENCES_RECORD, next, ctx.operationId);
    if (!wrote.ok) throw new Error(/record_scope_denied|scope/i.test(wrote.error ?? '') ? 'your storage grant predates preferences — refresh the grant on Today, then say it again' : (wrote.error ?? 'the preferences could not be kept'));
    return { changed: true, tier: 'private', record: PREFERENCES_RECORD, preferences: next, answer: `Done — your agent ${words(next)}.` };
  };
}
