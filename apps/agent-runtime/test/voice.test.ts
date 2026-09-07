// Spec 369 — the agent hears (deterministic repair) and decides what is said (spoken rendering).
import { describe, expect, it } from 'vitest';
import { repairTranscript, normalizeSpoken, hearingVocabulary, spokenFor, plainSpeech } from '../src/voice.js';

describe('deterministic repair of what was heard', () => {
  const labels = ['alice2.treasury', 'USDC', 'calvary.org', 'nathan.me', 'Missio Nexus'];

  it('rewrites a window that normalises EXACTLY to a known label, and says so', () => {
    const r = repairTranscript('send 10 you s d c to Alice to treasury', labels);
    expect(r.text).toBe('send 10 USDC to alice2.treasury');
    expect(r.repairs).toEqual([{ from: 'you s d c', to: 'USDC' }, { from: 'Alice to treasury', to: 'alice2.treasury' }]);
  });

  it('folds homophones only inside the comparison — ordinary words stay as heard', () => {
    const r = repairTranscript('pay for the trip to calvary dot org', labels);
    expect(r.text).toBe('pay for the trip to calvary.org');
    expect(r.repairs).toEqual([{ from: 'calvary dot org', to: 'calvary.org' }]);
  });

  it('never guesses: a near miss is left alone', () => {
    const r = repairTranscript('send it to alice three treasury', labels);
    expect(r.text).toBe('send it to alice three treasury');
    expect(r.repairs).toEqual([]);
  });

  it('keeps trailing punctuation and matches multi-word organization names', () => {
    const r = repairTranscript('how many members are in missio nexus?', labels);
    expect(r.text).toBe('how many members are in Missio Nexus?');
  });

  it('normalises the way people say typed names', () => {
    expect(normalizeSpoken('Alice to treasury')).toBe('alice2treasury');
    expect(normalizeSpoken('alice2.treasury')).toBe('alice2treasury');
    expect(normalizeSpoken('nathan dot me')).toBe('nathanme');
  });
});

describe("the ear's vocabulary", () => {
  it('is names plus verbs, deduplicated and bounded, as a prose prompt', () => {
    const v = hearingVocabulary({ names: ['alice2.treasury', 'alice2.treasury', 'Bob'], verbs: ['send money', 'send money', 'invite someone'] });
    expect(v.labels).toEqual(['USDC', 'ETH', 'alice2.treasury', 'Bob']);
    expect(v.prompt).toBe('Names: USDC, ETH, alice2.treasury, Bob. Things people ask: send money; invite someone.');
  });
});

describe('what is said', () => {
  const nameOf = async (a: string) => (a === '0x00000000000000000000000000000000000000b0' ? 'bob.me' : null);
  const words = (id: string) => ({ 'treasury.payment.execute': 'send money' } as Record<string, string>)[id] ?? id;

  it('reads an answer with markdown stripped and addresses named', async () => {
    const s = await spokenFor({ kind: 'answer', text: '**Bob** is at `0x00000000000000000000000000000000000000b0`, and 0xdeadbeefcafe is not.' }, nameOf, words);
    expect(s).toBe('Bob is at bob.me, and an address is not.');
  });

  it('says what a submission established, not the outcome', async () => {
    const s = await spokenFor({ kind: 'done', fulfillment: { established: 'submission', words: 'invite someone: submitted and recorded' } }, nameOf, words);
    expect(s).toBe('Submitted — invite someone: submitted and recorded.');
  });

  it('authority and signatures are READ, never answered by voice', async () => {
    expect(await spokenFor({ kind: 'authority_required', capability: 'treasury.payment.execute' }, nameOf, words))
      .toBe('This needs your authority to send money. Review it and use Grant and continue on screen to sign.');
    expect(await spokenFor({ kind: 'prompt', prompt: { kind: 'signature', prompt: 'Sign the invitation.' } }, nameOf, words))
      .toBe('Sign the invitation. This needs your signature — use Sign and continue on screen.');
  });

  it('lists choices with ordinals so they can be answered by ear', async () => {
    const s = await spokenFor({ kind: 'prompt', prompt: { kind: 'data', prompt: 'Which Nathan?', fields: [{ name: 'recipient', label: 'who', type: 'choice', choices: [{ value: '0x1', label: 'nathan.me' }, { value: '0x2', label: 'nathan.org' }] }] } }, nameOf, words);
    expect(s).toBe('Which Nathan? Options: first, nathan.me; second, nathan.org.');
  });

  it('plain speech strips markdown', () => {
    expect(plainSpeech('# Title\n- **bold** and `code` and [link](http://x)')).toBe('Title bold and code and link');
  });
});
