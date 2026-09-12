import { describe, it, expect } from 'vitest';
import { PLAYBOOK_ANSWER_TOOL, playbookAnswerAvailable, playbookAnswerInvoker } from '../src/playbook-answer.js';

const ctx = { step: { id: 's1', toolId: PLAYBOOK_ANSWER_TOOL.id, args: {} }, index: 0 } as never;
const material = { skill: 'poker.advise', input: { seat: 0, view: { hand: { street: 'flop' } }, legal: { fold: true, check: false, call: 4 } }, question: 'should I call?' };
/** A model that answers with the tool's shape, and records what it was shown. */
const fakeCall = (reply: Record<string, unknown>) => {
  const seen: Array<{ system: string; user: string; tool: string }> = [];
  const call = async (input: { system: string; messages: Array<{ content: string }>; tool: { name: string } }) => { seen.push({ system: input.system, user: input.messages[0]!.content, tool: input.tool.name }); return reply; };
  return { call, seen };
};

describe('playbook.answer — a question of judgement, answered from the playbook', () => {
  it('is LISTED only for a named skill the addressee advertises, with a model to answer with', () => {
    const { call } = fakeCall({ say: 'x' });
    expect(playbookAnswerAvailable({ call, material, advertised: ['poker.advise'] })).toBe(true);
    expect(playbookAnswerAvailable({ call, material, advertised: ['POKER.ADVISE'] })).toBe(true);
    // The card room's question to an agent that never said it answers it.
    expect(playbookAnswerAvailable({ call, material, advertised: ['messaging.deliver'] })).toBe(false);
    // No material ⇒ nothing to answer from; a tool that cannot run is not listed.
    expect(playbookAnswerAvailable({ call, material: null, advertised: ['poker.advise'] })).toBe(false);
    expect(playbookAnswerAvailable({ call: undefined, material, advertised: ['poker.advise'] })).toBe(false);
  });

  it('answers under the playbook\'s instructions, over the material, in the shape a card room decodes', async () => {
    const { call, seen } = fakeCall({ say: 'Call.', because: 'Four into twelve is 25%.', action: { type: 'call' } });
    const invoke = playbookAnswerInvoker({ call, instructions: 'You are Alice\'s agent. Never call out of position.', material, advertised: ['poker.advise'], agentName: 'alice.me' });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.advise', question: 'should I call?' }, ctx)) as Record<string, unknown>;
    expect(out.refused).toBeUndefined();
    expect(out.say).toBe('Call.');
    expect(out.action).toEqual({ type: 'call' });
    expect(out.source).toBe('alice.me');
    // `answer` is what the deterministic renderer emits — the JSON, verbatim, nothing composed around it.
    expect(JSON.parse(String(out.answer))).toEqual({ say: 'Call.', because: 'Four into twelve is 25%.', action: { type: 'call' } });
    // The playbook led; the material and the question were shown; the model was asked for advice.
    expect(seen[0]!.system).toContain('Never call out of position');
    expect(seen[0]!.user).toContain('"call":4');
    expect(seen[0]!.user).toContain('should I call?');
    expect(seen[0]!.tool).toBe('advice');
  });

  it('refuses a skill the agent does not advertise, and answers nothing without material', async () => {
    const { call } = fakeCall({ say: 'x' });
    const invoke = playbookAnswerInvoker({ call, material, advertised: ['canasta.advise'], agentName: 'alice.me' });
    expect(await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.advise' }, ctx)).toEqual({ refused: 'alice.me does not advertise poker.advise' });
    const none = playbookAnswerInvoker({ call, material: null, advertised: ['poker.advise'] });
    expect(await none(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.advise' }, ctx)).toEqual({ refused: 'the message carried no material to answer from' });
  });

  it('REMEMBERS a record without a model: the round\'s counts fold into the agent\'s own vault', async () => {
    const { call, seen } = fakeCall({ say: 'never' });
    const vault = new Map<string, unknown>();
    const memory = { read: async (t: string) => vault.get(t) ?? null, write: async (t: string, r: unknown) => { vault.set(t, r); return { ok: true }; } };
    const round = (vpip: number) => ({ ...material, skill: 'poker.record', input: { seat: 0, view: {}, observation: { subjects: { 'agent:sharkbot.svc': { label: 'Sharkbot', counters: { hands: 1, vpip, pfr: vpip, foldToBetOpps: 1, foldToBet: 0 } }, me: { you: true, counters: { hands: 1, vpip: 1 } } } } } });
    const invoke = playbookAnswerInvoker({ call, material: round(1), advertised: ['poker.record'], agentName: 'alice.me', memory });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx)) as Record<string, unknown>;
    expect(seen).toHaveLength(0); // no model call — arithmetic is not judgement
    expect(out.kept).toBe(true);
    expect(out.record).toBe('playbook.memory:poker');
    expect(out.say).toContain('Remembered round 1');
    expect(JSON.parse(String(out.answer))).toEqual({ say: out.say });
    // A second round ADDS: counts accumulate, rounds count up, the label and "you" survive.
    await playbookAnswerInvoker({ call, material: round(0), advertised: ['poker.record'], memory })(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx);
    const mem = vault.get('playbook.memory:poker') as { rounds: number; subjects: Record<string, { rounds: number; label?: string; you?: boolean; counters: Record<string, number> }> };
    expect(mem.rounds).toBe(2);
    expect(mem.subjects['agent:sharkbot.svc']).toMatchObject({ rounds: 2, label: 'Sharkbot', counters: { hands: 2, vpip: 1, pfr: 1, foldToBetOpps: 2, foldToBet: 0 } });
    expect(mem.subjects.me).toMatchObject({ you: true, counters: { hands: 2, vpip: 2 } });
  });

  it('a record with nothing to count, or no memory to keep it in, is acknowledged and costs nothing', async () => {
    const { call, seen } = fakeCall({ say: 'never' });
    const bare = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.record' }, advertised: ['poker.record'] });
    const out = (await bare(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx)) as Record<string, unknown>;
    expect(out.say).toContain('nothing to count');
    const noVault = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.record', input: { observation: { subjects: { x: { counters: { hands: 1 } } } } } }, advertised: ['poker.record'] });
    expect(((await noVault(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx)) as Record<string, unknown>).kept).toBe(false);
    // A vault that refuses (a grant signed before the scope existed) is reported, never thrown.
    const refusing = { read: async () => null, write: async () => ({ ok: false, error: 'record_scope_denied' }) };
    const denied = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.record', input: { observation: { subjects: { x: { counters: { hands: 1 } } } } } }, advertised: ['poker.record'], memory: refusing });
    const d = (await denied(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.record' }, ctx)) as Record<string, unknown>;
    expect(d.kept).toBe(false);
    expect(d.say).toContain('record_scope_denied');
    expect(seen).toHaveLength(0);
  });

  it('advice is shown what the agent remembers about the players AT THIS TABLE, with rates, and nobody else', async () => {
    const { call, seen } = fakeCall({ reasoning: 'r', say: 'Raise.', because: 'He folds to bets.' });
    const memory = {
      read: async () => ({ type: 'ap.playbook-memory.v1', family: 'poker', rounds: 12, updatedAt: 'x', subjects: {
        'agent:sharkbot.svc': { label: 'Sharkbot', rounds: 12, seen: '2026-09-11T00:00:00Z', counters: { hands: 12, vpip: 3, pfr: 3, foldToBetOpps: 5, foldToBet: 4, aggressive: 9, passive: 3 } },
        'agent:elsewhere.svc': { label: 'Elsewhere', rounds: 12, seen: '2026-09-11T00:00:00Z', counters: { hands: 12, vpip: 12 } },
        me: { you: true, rounds: 12, seen: '2026-09-11T00:00:00Z', counters: { hands: 12, vpip: 9 } },
      } }),
      write: async () => ({ ok: true }),
    };
    const atTable = { ...material, input: { ...(material.input as object), view: { seats: [{ seat: 0, playerId: 'me' }, { seat: 1, playerId: 'agent:sharkbot.svc' }] } } };
    const invoke = playbookAnswerInvoker({ call, material: atTable, advertised: ['poker.advise'], memory });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.advise' }, ctx)) as Record<string, unknown>;
    expect(out.remembered).toEqual(['me:12', 'Sharkbot:12']);
    const shown = seen[0]!.user;
    expect(shown).toContain('Remembered');
    expect(shown).toContain('"vpip":"25% of 12"');
    expect(shown).toContain('"foldToBet":"80% of 5"');
    expect(shown).toContain('"aggressionFactor":"3.0 (9 bets/raises to 3 calls)"');
    expect(shown).not.toContain('"aggressive":"75%'); // a tally across streets is not a per-hand rate
    expect(shown).not.toContain('Elsewhere');
    // The raw observation never rides into an advice prompt; it is the record's, and it is already counted.
    expect(shown).not.toContain('"observation"');
  });

  it('is a read that reads nothing: no capability, so no mandate is ever asked for', () => {
    expect(PLAYBOOK_ANSWER_TOOL.capability).toBeUndefined();
    expect(PLAYBOOK_ANSWER_TOOL.establishes).toBe('lookup');
    expect(PLAYBOOK_ANSWER_TOOL.answer).toBe('{{answer}}');
  });
});

describe('the craft that applies, not the whole doctrine', () => {
  const doctrine = [
    'You are a **Person Steward** — the agent of one person.',
    '',
    'What you can do: pay, invite, read a card table.',
    '',
    '## How each act is done',
    '',
    'One section per act.',
    '',
    '### Execute a treasury payment — moves value out of a treasury',
    'Payment doctrine here.',
    '### holdem-table-read — Reads a Texas Hold\'em hand from the person\'s own seat',
    'Price first. Then outs.',
    '### Invite a member — asks somebody to join',
    'Invitation doctrine here.',
    '### canasta-style — how this person plays canasta',
    'Never hold wilds too long.',
  ].join('\n');

  it('keeps the opening and only the sections about the skill\'s game', async () => {
    const { relevantInstructions } = await import('../src/playbook-answer.js');
    const poker = relevantInstructions(doctrine, 'poker.advise');
    expect(poker).toContain('Person Steward');
    expect(poker).toContain('Price first');
    expect(poker).not.toContain('Payment doctrine');
    expect(poker).not.toContain('Invitation doctrine');
    expect(poker).not.toContain('wilds');
    const canasta = relevantInstructions(doctrine, 'canasta.advise');
    expect(canasta).toContain('wilds');
    expect(canasta).not.toContain('Price first');
  });

  it('keeps everything for a skill outside any game, because there is no basis to cut', async () => {
    const { relevantInstructions } = await import('../src/playbook-answer.js');
    expect(relevantInstructions(doctrine, 'adv:tax-position-analysis')).toBe(doctrine);
    expect(relevantInstructions('', 'poker.advise')).toBe('');
  });
});

describe('the street selects the stage', () => {
  const doctrine = [
    'You are a **Person Steward**.',
    '',
    '## How each act is done',
    '',
    '### holdem-table-read — Reads a Texas Hold\'em hand from the person\'s own seat',
    'Price first.',
    '### holdem-preflop — Before the flop at Texas Hold\'em',
    'The branch first.',
    '### holdem-flop — The flop at Texas Hold\'em',
    'Whose board is it.',
    '### holdem-river — The river at Texas Hold\'em',
    'Nothing left to come.',
  ].join('\n');

  it('keeps the shared craft and only the current street\'s stage', async () => {
    const { relevantInstructions } = await import('../src/playbook-answer.js');
    const flop = relevantInstructions(doctrine, 'poker.advise', 'flop');
    expect(flop).toContain('Price first');
    expect(flop).toContain('Whose board is it');
    expect(flop).not.toContain('The branch first');
    expect(flop).not.toContain('Nothing left to come');
    const river = relevantInstructions(doctrine, 'poker.advise', 'river');
    expect(river).toContain('Nothing left to come');
    expect(river).not.toContain('Whose board is it');
  });

  it('keeps every stage when no street is known — nothing to select on', async () => {
    const { relevantInstructions } = await import('../src/playbook-answer.js');
    const all = relevantInstructions(doctrine, 'poker.advise', null);
    expect(all).toContain('The branch first');
    expect(all).toContain('Nothing left to come');
  });
});
