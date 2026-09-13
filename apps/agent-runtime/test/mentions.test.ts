// Spec 400 W2 (B3) — mention parsing and resolution, with no network: handles once each, typed or bare; a bare label
// tries the typed suffixes in roster order and stops at the first that resolves; a non-member resolves to nothing;
// the organization itself is excluded (its assistant hears it another way); the topic thread id round-trips.
import { describe, it, expect } from 'vitest';
import { mentionsIn, resolveMentions, topicThreadId, parseTopicThread } from '../src/mentions.js';

const ORG = '0x00000000000000000000000000000000000000cc';
const GOOSE = '0x00000000000000000000000000000000000000aa';
const BOB = '0x00000000000000000000000000000000000000bb';

describe('mentions', () => {
  it('parses handles once each, typed or bare, ignoring emails', () => {
    expect(mentionsIn('@goose-2 what is the plan? cc @Goose-2 and @bob.me, mail me@x.org')).toEqual([{ label: 'goose-2' }, { label: 'bob', suffix: 'me' }]);
    expect(mentionsIn('nothing here')).toEqual([]);
  });
  it('resolves to member agents only; the org is excluded; unknown is nothing', async () => {
    const names: Record<string, string> = { 'goose-2.svc': GOOSE, 'bob.me': BOB, 'missio-nexus.org': ORG };
    const io = { resolveName: async (n: string) => (names[n] ?? null) as never, isMember: async (a: string) => a === GOOSE, exclude: [ORG as never] };
    expect(await resolveMentions(mentionsIn('@goose-2 @bob @missio-nexus @nobody'), io)).toEqual([{ label: 'goose-2', name: 'goose-2.svc', agent: GOOSE }]);
  });
  it('thread ids round-trip', () => {
    const t = topicThreadId(ORG, 'ch_1');
    expect(parseTopicThread(t)).toEqual({ org: ORG, channelId: 'ch_1' });
    expect(parseTopicThread('dm:abc')).toBeNull();
  });
});
