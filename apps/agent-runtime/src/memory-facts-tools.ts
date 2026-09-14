// MEMORY THAT FOLLOWS THE PERSON — spec 402 W1. Three capabilities over ONE vault record (`memory.facts`,
// apctx:RememberedFact): remember (the person says so, or her agent learned it and says where from), list (what her agent
// knows about her), forget (one fact by id). Self-acting like a standing instruction or a household note: the record is
// hers, in her vault, under her own standing — no mandate, no signature — because it authorizes nothing: a fact fills a
// question before it is asked; no verifier reads it. The same memory reaches every way in — the Home, Claude through the
// Home MCP, a paired runtime — because each asks the same agent; an organization's agent does not read it.
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { rememberFact, forgetFact, factsOf, FACTS_RECORD, type RememberedFactsV1 } from '@agenticprimitives/context';

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
  inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, in the person\'s words' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['fact'] },
  capability: { id: MEMORY_REMEMBER, action: 'remember', resourceArg: 'record', authorityArg: 'holder' },
  risk: 'low',
  selfAuthorized: true,
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
  risk: 'low',
  selfAuthorized: true,
  interaction: { navigationTarget: 'memory' },
};

export const MEMORY_TOOLS: ToolSpec[] = [MEMORY_REMEMBER_TOOL, MEMORY_LIST_TOOL, MEMORY_FORGET_TOOL];
export const MEMORY_ACTS = new Set<string>([MEMORY_REMEMBER, MEMORY_FORGET]);

export interface MemoryFactsDeps {
  readSubjectRecord?: (subject: string, key: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, key: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
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
        const r = rememberFact(prev, { fact: String(args.fact ?? ''), source: 'you', saidAs: said, ...(runRef ? { runRef } : {}), ...(Array.isArray(args.tags) ? { tags: (args.tags as unknown[]).map(String) } : {}) });
        if ('error' in r) throw new Error(r.error);
        const wrote = await deps.writeSubjectRecord(me, FACTS_RECORD, r.next);
        if (!wrote.ok) throw new Error(wrote.error ?? 'the fact could not be kept');
        return { remembered: true, updated: r.updated, id: r.entry.id, fact: r.entry.fact, tier: 'private', record: FACTS_RECORD, count: r.next.entries.length, note: r.updated ? 'I already had that — refreshed.' : 'Kept in your own vault; forget it any time on Memory.' };
      }
      case MEMORY_FORGET: {
        const id = typeof args.id === 'string' && args.id ? args.id : null;
        const words = String(args.words ?? '').trim().toLowerCase();
        const target = id ? prev.entries.find((e) => e.id === id) : words ? prev.entries.find((e) => e.fact.toLowerCase().includes(words)) : undefined;
        if (!target) return { forgotten: false, refused: id ? `no remembered fact has the id ${id}` : words ? `nothing I remember contains "${words}"` : 'say which fact — its id, or words it contains', count: prev.entries.length };
        const r = forgetFact(prev, target.id);
        const wrote = await deps.writeSubjectRecord(me, FACTS_RECORD, r.next);
        if (!wrote.ok) throw new Error(wrote.error ?? 'the fact could not be forgotten');
        return { forgotten: true, id: target.id, fact: target.fact, tier: 'private', record: FACTS_RECORD, count: r.next.entries.length };
      }
      default: throw new Error(`${toolId} is not a memory capability`);
    }
  };
}

export type { RememberedFactsV1 };
