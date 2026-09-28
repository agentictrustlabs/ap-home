// MEMORY THAT FOLLOWS THE PERSON — spec 402 W1. Three capabilities over ONE vault record (`memory.facts`,
// apctx:RememberedFact): remember (the person says so, or her agent learned it and says where from), list (what her agent
// knows about her), forget (one fact by id). Self-acting like a standing instruction or a household note: the record is
// hers, in her vault, under her own standing — no mandate, no signature — because it authorizes nothing: a fact fills a
// question before it is asked; no verifier reads it. The same memory reaches every way in — the Home, Claude through the
// Home MCP, a paired runtime — because each asks the same agent; an organization's agent does not read it.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { rememberFact, forgetFact, factsOf, FACTS_RECORD, type RememberedFactsV1 } from '@agenticprimitives/context';
import { requirePersonsTurn } from './persons-turn.js';
import { ADAPTER, CARRIES } from './adapter-declarations.js';

export const MEMORY_REMEMBER = 'person.memory.remember' as const;
export const MEMORY_LIST = 'person.memory.list' as const;
export const MEMORY_FORGET = 'person.memory.forget' as const;

export const MEMORY_REMEMBER_TOOL: ToolSpec = {
  id: MEMORY_REMEMBER,
  verbs: ['remember that', 'remember this', 'keep in mind', 'note that i', 'my daughter is', 'i prefer', "don't forget that"],
  description:
    'REMEMBERS one durable fact about the PERSON ASKING, in their own words, in their own vault — "remember that I lead the Thursday circle", '
    + '"my daughter is Ana", "I prefer morning meetings". Use it when the person says remember / keep in mind, or states a durable fact about '
    + 'themselves worth keeping (not a one-off request, not a fact about someone else, not something a record already holds). Args: fact (one or two '
    + 'sentences, in their words), tags (optional words like family, work). It authorizes nothing and is theirs alone.',
  inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, in the person\'s words' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string', enum: ['you', 'connector'], description: 'connector when the fact was read off a connected account the person confirmed' }, from: { type: 'string', description: 'Which account, when source is connector (Google Calendar)' } }, required: ['fact'] },
  capability: { id: MEMORY_REMEMBER, action: 'remember', resourceArg: 'record', authorityArg: 'holder' },
  risk: 'low', adapter: ADAPTER.sync, carries: CARRIES.memory,
  selfAuthorized: true,
  // Spec 420 — honours a comparison's dry run: preconditions run, nothing is written.
  dryRun: 'invoke',
  interaction: { navigationTarget: 'memory' },
};

export const MEMORY_LIST_TOOL: ToolSpec = {
  id: MEMORY_LIST,
  answers: ['what do you remember about me', 'what do you know about me', 'what have I told you', 'my memory', 'what do you remember'],
  description: 'ANSWERS what this person\'s agent remembers about them — their remembered facts, each with when and how it was learned. Only for the person asking; takes no arguments.',
  inputSchema: { type: 'object', properties: {} },
  establishes: 'lookup',
  interaction: { navigationTarget: 'memory' },
};

export const MEMORY_FORGET_TOOL: ToolSpec = {
  id: MEMORY_FORGET,
  verbs: ['forget that', 'forget what I said about', 'stop remembering', 'that is no longer true'],
  description: 'FORGETS one remembered fact about the person asking — by its id (from person.memory.list) or by the words it contains. A receipt that cited the fact keeps its citation; the fact is no longer used.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, words: { type: 'string', description: 'Words the fact contains, when the id is not known' } } },
  capability: { id: MEMORY_FORGET, action: 'forget', resourceArg: 'record', authorityArg: 'holder' },
  risk: 'low', adapter: ADAPTER.sync,
  selfAuthorized: true,
  // Spec 420 — honours a comparison's dry run: preconditions run, nothing is written.
  dryRun: 'invoke',
  interaction: { navigationTarget: 'memory' },
};

export const MEMORY_TOOLS: ToolSpec[] = [MEMORY_REMEMBER_TOOL, MEMORY_LIST_TOOL, MEMORY_FORGET_TOOL];
export const MEMORY_ACTS = new Set<string>([MEMORY_REMEMBER, MEMORY_FORGET]);

export interface MemoryFactsDeps {
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown, operationId?: string) => Promise<{ ok: boolean; error?: string }>;
}

export function memoryFactsInvoker(deps: MemoryFactsDeps, person: string | undefined, runRef?: string, addressee?: string): ToolInvoker {
  return async (toolId, args, ctx) => {
    if (!person) throw new Error('memory is kept as you, and there is no signed-in person on this run');
    // THE OWNER'S OWN AGENT ONLY. Addressed to an organization or a service — a room — the person's memory is not read:
    // a room's run leaves records the room keeps, and her memory is not the room's to hold (agent-vocabulary.md §1).
    if (addressee && addressee.toLowerCase() !== person.toLowerCase()) return { refused: 'your memory is read by your own agent only — ask at your home, not in this room', holder: person.toLowerCase() };
    if (!deps.readSubjectRecord || !deps.writeSubjectRecord) throw new Error('this agent cannot keep memory (the private tier is not configured)');
    const me = person.toLowerCase();
    const prev = factsOf(await deps.readSubjectRecord(me, FACTS_RECORD).catch(() => null));
    switch (toolId) {
      case MEMORY_LIST:
        return { tier: 'private', record: FACTS_RECORD, count: prev.entries.length, facts: prev.entries.map((e) => ({ id: e.id, fact: e.fact, learnedAt: e.learnedAt, source: e.source, ...(e.from ? { from: e.from } : {}), ...(e.tags?.length ? { tags: e.tags } : {}) })), answer: prev.entries.length ? prev.entries.slice(0, 20).map((e) => `— ${e.fact} (${e.source === 'you' ? 'you told me' : e.source === 'agent' ? 'I learned' : `from ${e.from ?? 'a connected account'}`} ${e.learnedAt.slice(0, 10)})`).join('\n') : 'I remember nothing about you yet — say "remember that …" and I will.' };
      case MEMORY_REMEMBER: {
        const said = String((ctx.intent as { goal?: string }).goal ?? '');
        // Spec 409 §4 (R917-H-1): a fact is written on the PERSON'S turn, in her words, or it is read back first —
        // never by an unattended run, never on words the planner took from a page or a server.
        requirePersonsTurn({ ctx, toolId, what: `remember "${String(args.fact ?? '').slice(0, 160)}"`, saidWords: String(args.fact ?? '') });
        // Spec 402 W5b — a fact read off her connected account and CONFIRMED by her is kept as the connector's, named:
        // the card says "from Google Calendar", never "you told me". Only she can say so (this tool is hers alone).
        const from = typeof args.from === 'string' && args.from.trim() ? args.from.trim().slice(0, 60) : undefined;
        const source = args.source === 'connector' && from ? 'connector' as const : 'you' as const;
        if (ctx.dryRun) return { dryRun: true, wouldRemember: String(args.fact ?? '') };
        const r = rememberFact(prev, { fact: String(args.fact ?? ''), source, ...(source === 'connector' ? { from } : {}), saidAs: said, ...(runRef ? { runRef } : {}), ...(Array.isArray(args.tags) ? { tags: (args.tags as unknown[]).map(String) } : {}) });
        if ('error' in r) throw new Error(r.error);
        const wrote = await deps.writeSubjectRecord(me, FACTS_RECORD, r.next, ctx.operationId);
        if (!wrote.ok) throw new Error(wrote.error ?? 'the fact could not be kept');
        return { remembered: true, updated: r.updated, id: r.entry.id, fact: r.entry.fact, tier: 'private', record: FACTS_RECORD, count: r.next.entries.length, note: r.updated ? 'I already had that — refreshed.' : 'Kept in your own vault; forget it any time on Memory.' };
      }
      case MEMORY_FORGET: {
        requirePersonsTurn({ ctx, toolId, what: 'forget a remembered fact', ...(typeof args.words === 'string' && args.words.trim() ? { saidWords: args.words } : {}) });
        const id = typeof args.id === 'string' && args.id ? args.id : null;
        const words = String(args.words ?? '').trim().toLowerCase();
        const target = id ? prev.entries.find((e) => e.id === id) : words ? prev.entries.find((e) => e.fact.toLowerCase().includes(words)) : undefined;
        if (!target) return { forgotten: false, refused: id ? `no remembered fact has the id ${id}` : words ? `nothing I remember contains "${words}"` : 'say which fact — its id, or words it contains', count: prev.entries.length };
        if (ctx.dryRun) return { dryRun: true, wouldForget: target.fact, id: target.id };
        const r = forgetFact(prev, target.id);
        const wrote = await deps.writeSubjectRecord(me, FACTS_RECORD, r.next, ctx.operationId);
        if (!wrote.ok) throw new Error(wrote.error ?? 'the fact could not be forgotten');
        return { forgotten: true, id: target.id, fact: target.fact, tier: 'private', record: FACTS_RECORD, count: r.next.entries.length };
      }
      default: throw new Error(`${toolId} is not a memory capability`);
    }
  };
}

export type { RememberedFactsV1 };

// ── A MEMORY PROPOSED FROM THE CONVERSATION — spec 402 W1b ────────────────────────────────────────────
// ChatGPT learns a fact silently from what you say; ours PROPOSES. When the person, at her own agent, states something
// durable about herself in passing — "I lead the Thursday circle", "my daughter is Ana", "I prefer mornings" — the reply
// carries a one-click `next` ("remember that …") and nothing is written until she clicks. Deterministic: a closed set of
// first-person markers, no model; a question, a request, or a fact already remembered proposes nothing.
const FACT_MARKERS = /\b(i am (?:a|an|the|not|from|in|on|at)\b|i'm (?:a|an|the|not|from|in|on|at|allergic)\b|i prefer\b|i (?:really )?(?:like|love|hate|dislike|enjoy)\b|i don't (?:like|eat|drink)\b|i lead\b|i run\b|i teach\b|i serve\b|i work (?:at|for|as|in)\b|i live (?:in|at|on)\b|i go by\b|call me\b|my (?:daughter|son|kids?|children|wife|husband|spouse|partner|mother|mom|father|dad|parents|sister|brother|pastor|church|team|circle|small group|birthday|anniversary|allergy|allergies|doctor|dentist|car|dog|cat)\b|i (?:was born|grew up|got married|retired)\b|i usually\b|i always\b|i never\b)/i;
const NOT_A_FACT = /^(what|which|when|where|who|why|how|do|does|did|is|are|can|could|would|should|will|remember|forget|tell|show|find|send|pay|invite|add|remove|draft|schedule|every|each|when(?:ever)?)\b|\?\s*$/i;

export function memoryProposalFor(goal: string, remembered: ReadonlyArray<{ fact: string }>): { capability: typeof MEMORY_REMEMBER; args: { fact: string }; words: string; why: string } | null {
  const text = goal.trim().replace(/\s+/g, ' ');
  if (text.length < 8 || text.length > 400) return null;
  // the clause that carries the marker — split on sentence ends and semicolons; a clause that is a question or a
  // request ("what's on my calendar?", "pay bob") proposes nothing, whatever else the sentence says
  const clause = text.split(/(?<=[.!;?])\s+/).find((c) => FACT_MARKERS.test(c) && !NOT_A_FACT.test(c.trim())) ?? '';
  if (!clause) return null;
  const fact = clause.replace(/^(?:also|and|by the way|btw|fyi|oh|well|so),?\s+/i, '').replace(/[.!;]+$/, '').trim();
  if (fact.length < 8) return null;
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  if (remembered.some((r) => norm(r.fact) === norm(fact) || norm(r.fact).includes(norm(fact)) || norm(fact).includes(norm(r.fact)))) return null;
  return { capability: MEMORY_REMEMBER, args: { fact }, words: `remember that ${fact.replace(/^i /i, 'I ')}`, why: 'you said something about yourself worth keeping — kept only if you say so, in your own vault, forgettable' };
}

// ── A MEMORY PROPOSED FROM A CONNECTED ACCOUNT — spec 402 W5b ─────────────────────────────────────────
// What her calendar shows repeating is a habit worth remembering: "Elders meeting every Tuesday at 7:00 PM". It is read
// off the events her agent just listed AS HER (a `recurring` instance), said back as a proposal, and kept only if she
// clicks — kept as the CONNECTOR's, named ("from Google Calendar"), so the card never says she told us. Deterministic:
// the first repeating event not already remembered; a one-off event proposes nothing; mail and files propose nothing
// (nothing in them is a fact about her the way a standing appointment is).
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function connectorMemoryProposal(results: ReadonlyArray<{ toolId: string; result: unknown }>, remembered: ReadonlyArray<{ fact: string }>, tz?: string): { capability: typeof MEMORY_REMEMBER; args: { fact: string; source: 'connector'; from: string }; words: string; why: string } | null {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
  for (const r of results) {
    if (r.toolId !== 'calendar.events.list' || !r.result || typeof r.result !== 'object') continue;
    const events = (r.result as { events?: Array<{ summary?: string; start?: string; allDay?: boolean; recurring?: boolean; status?: string }> }).events ?? [];
    for (const e of events) {
      if (!e.recurring || e.status === 'cancelled' || !e.summary || !e.start) continue;
      const when = Date.parse(e.start);
      if (!Number.isFinite(when)) continue;
      const zone = tz && /^[A-Za-z_]+\/[A-Za-z_+-]+$|^UTC$/.test(tz) ? tz : undefined;
      let day: string; let time: string;
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...(zone ? { timeZone: zone } : {}), weekday: 'long', hour: 'numeric', minute: '2-digit' }).formatToParts(when).map((p) => [p.type, p.value]));
        day = String(parts.weekday ?? ''); time = `${parts.hour ?? ''}:${parts.minute ?? ''} ${parts.dayPeriod ?? ''}`.trim();
      } catch { day = DAY_NAMES[new Date(when).getUTCDay()] ?? ''; time = ''; }
      if (!day) continue;
      const fact = `I have ${e.summary.trim().slice(0, 80)} every ${day}${e.allDay || !time ? '' : ` at ${time}`}`;
      const summary = norm(e.summary);
      if (remembered.some((m) => norm(m.fact) === norm(fact) || (norm(m.fact).includes(summary) && /\bevery\b/.test(norm(m.fact))))) continue;
      return { capability: MEMORY_REMEMBER, args: { fact, source: 'connector', from: 'Google Calendar' }, words: `remember that ${fact}`, why: 'your calendar shows this repeats — kept only if you say so, named as from Google Calendar, forgettable' };
    }
  }
  return null;
}
