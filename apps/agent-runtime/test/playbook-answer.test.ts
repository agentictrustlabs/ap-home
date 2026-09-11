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

  it('acknowledges a review in one line and never advises on a finished round', async () => {
    const { call, seen } = fakeCall({ say: 'You held wilds too long twice this round.' });
    const invoke = playbookAnswerInvoker({ call, material: { ...material, skill: 'poker.review' }, advertised: ['poker.review'] });
    const out = (await invoke(PLAYBOOK_ANSWER_TOOL.id, { skill: 'poker.review' }, ctx)) as Record<string, unknown>;
    expect(out.say).toContain('wilds');
    expect(out.action).toBeUndefined();
    expect(seen[0]!.tool).toBe('reviewed');
    expect(seen[0]!.system).toContain('Do not advise');
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
