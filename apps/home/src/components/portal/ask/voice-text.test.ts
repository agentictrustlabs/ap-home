import { describe, expect, it } from 'vitest';
import { yesNo, matchChoice, listenAfter, plainSpeech } from './voice-text';
import { pickVoice, speechChunks } from './useVoice';
import type { AskReply } from '../../../home/ask';

describe('a spoken answer meets a prompt', () => {
  it('hears yes and no, and neither', () => {
    expect(yesNo('yeah go ahead')).toBe('yes');
    expect(yesNo('approve')).toBe('yes');
    expect(yesNo('I approve that')).toBe('yes');
    expect(yesNo("no, don't")).toBe('no');
    expect(yesNo('hmm, maybe later')).toBeNull();
  });

  it('picks a choice by ordinal, by label, or by a distinctive word — and refuses two hits', () => {
    const choices = [{ value: '0x1', label: 'nathan.me' }, { value: '0x2', label: 'nathan.org' }, { value: '0x3', label: 'Missio Nexus' }];
    expect(matchChoice('the second one', choices)).toBe('0x2');
    expect(matchChoice('number 3', choices)).toBe('0x3');
    expect(matchChoice('nathan dot org', choices)).toBeNull();     // "nathan" hits two; "org" alone is short — asked again
    expect(matchChoice('missio', choices)).toBe('0x3');
    expect(matchChoice('nathan.me please', choices)).toBe('0x1');
  });
});

describe('when the mic may reopen', () => {
  const base = { runRef: 'r', receipts: [] as unknown[] };
  it('after a question, yes; after authority or a signature, also yes — "approve" is listened for', () => {
    expect(listenAfter({ kind: 'answer', text: 'hi', runRef: 'r' } as AskReply)).toBe(true);
    expect(listenAfter({ kind: 'prompt', runRef: 'r', resumeToken: 't', prompt: { kind: 'data', stepRef: 's', toolId: 'x', prompt: 'who?', fields: [] } } as AskReply)).toBe(true);
    expect(listenAfter({ kind: 'prompt', runRef: 'r', resumeToken: 't', prompt: { kind: 'signature', stepRef: 's', toolId: 'x', prompt: 'sign', digest: '0x00', signer: '0x1' } } as unknown as AskReply)).toBe(true);
    expect(listenAfter({ kind: 'authority_required', ...base } as unknown as AskReply)).toBe(true);
  });
});

describe('plain speech', () => {
  it('strips markdown and never reads an address', () => {
    expect(plainSpeech('**Bob** at `0xabcdef0123`')).toBe('Bob at an address');
  });
});

describe('the voice and its pieces', () => {
  it('prefers a natural female English voice, else the platform female, else none (engine default)', () => {
    const v = (name: string, lang = 'en-US') => ({ name, lang } as SpeechSynthesisVoice);
    expect(pickVoice([v('Microsoft David - English (United States)'), v('Microsoft Zira - English (United States)'), v('Microsoft Aria Online (Natural) - English (United States)')])?.name).toMatch(/Aria/);
    expect(pickVoice([v('Microsoft David - English (United States)'), v('Microsoft Zira - English (United States)')])?.name).toMatch(/Zira/);
    expect(pickVoice([v('Microsoft Hedda - German', 'de-DE'), v('Microsoft David - English (United States)')])).toBeNull();
  });
  it('speaks long text as sentence-sized pieces so the engine finishes each one', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Team number ${i + 1} is here.`).join(' ');
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join(' ')).toBe(text);
    expect(speechChunks('Done.')).toEqual(['Done.']);
  });
});
