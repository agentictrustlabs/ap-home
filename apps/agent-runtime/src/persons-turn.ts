// THE PERSON'S TURN — spec 409 §4 (R917-H-1 / H-5).
//
// A self-authorized write (a remembered fact, a preference, a removed routine) needs no mandate because the record is
// the person's own and authorizes nothing. What it DOES do is shape every later turn: a remembered fact fills a question
// before it is asked. So the one thing that must be true of such a write is that the PERSON asked for it — not a message
// on a thread, not a web page the planner just read, not an external server's answer. Three checks, all deterministic:
//
//   1. the run is a person's turn: an unattended run (`intent.context.trigger` — a schedule, a message, an event, a
//      webhook) never writes memory or preferences and never removes a routine;
//   2. nothing untrusted has been read this run (`InvokeContext.untrustedSeen`): after a web page, a file or an external
//      MCP answer, the write PARKS with a read-back instead of running on words the planner may have taken from it;
//   3. for a remembered fact: the fact is in the person's own sentence, or the write parks with a read-back.
//
// A parked write is an `InputRequired` exactly like `routine.declare`'s: the reply carries the words and a `keep`
// field; `keep: yes` on the resume runs it. Nothing here grants anything — it only refuses to act on words that are
// not the person's.
import { InputRequired, dataFor, type InvokeContext } from '@agenticprimitives/orchestration';

export interface PersonsTurnInput {
  ctx: InvokeContext;
  toolId: string;
  /** What the write would do, in the person's words — the read-back prompt names it. */
  what: string;
  /** For a remembered fact: the words the write would keep; it runs without a read-back only when the person's own
   *  sentence contains them. Omit for writes whose arguments the person cannot have dictated (a removal by id). */
  saidWords?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Why this run is not a person's turn, or null. An unattended run names its trigger in the intent context. */
export function unattendedReason(ctx: Pick<InvokeContext, 'intent'>): string | null {
  const c = (ctx.intent as { context?: Record<string, unknown> }).context ?? {};
  if (typeof c.trigger === 'string' && c.trigger) return 'a routine, a message, an event or a webhook fired this run — a self-acting write happens only on your own turn';
  if (c.message && typeof c.message === 'object') return 'this run was fired by a message on a thread — a self-acting write happens only on your own turn';
  return null;
}

/**
 * Admit a self-authorized write, or throw: an `Error` when the run is not a person's turn (refused), an
 * `InputRequired` when the write must be read back first (parked). Returns silently when the write may run now:
 * the person's own turn, nothing untrusted read, and — for a fact — the words are the person's own, or `keep: yes`
 * was supplied on a resume.
 */
export function requirePersonsTurn(input: PersonsTurnInput): void {
  const { ctx, toolId } = input;
  const stepRef = ctx.step.id ?? `s${ctx.index}`;
  const unattended = unattendedReason(ctx);
  if (unattended) throw new Error(`${input.what} was not kept: ${unattended}`);
  const supplied = dataFor(ctx.supplied, stepRef);
  const keep = String(supplied.keep ?? '').trim().toLowerCase();
  if (keep === 'yes') return;
  if (keep && keep !== 'yes') throw new Error(`${input.what} — not kept, as you said`);
  const goal = norm(String((ctx.intent as { goal?: string }).goal ?? ''));
  const said = input.saidWords !== undefined ? norm(input.saidWords) : null;
  const inHerWords = said === null ? true : said.length > 0 && goal.includes(said);
  if (!ctx.untrustedSeen && inHerWords) return;
  const because = ctx.untrustedSeen
    ? 'this run read something from outside (a page, a file, a connected server) before this'
    : 'these are not the words you used';
  throw new InputRequired({
    kind: 'data', stepRef, toolId,
    prompt: `${input.what} — ${because}. Keep it?`,
    fields: [{ name: 'keep', label: 'Keep it?', type: 'text', required: true, hint: 'yes or no' }],
  });
}
