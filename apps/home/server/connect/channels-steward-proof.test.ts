/**
 * Every write to the channels DO must carry the steward proof.
 *
 * The DO's `communityPresence` admits a caller on ONE of three things: a current directory listing, a
 * member-access grant, or stewardship — and stewardship is only visible to it if the caller SENDS the
 * wire. This route computes it once (`stewardWireFor`) and spreads it into each `callInteractions`.
 *
 * `channels.post` was the one branch that computed it and did not pass it. The result was absurd from
 * the outside: a steward could read a topic, create topics, and configure the topic's assistant — and
 * got "join this community first" when they tried to say anything in one.
 *
 * A per-branch unit test would not have caught it (the branch behaved exactly as written), so this reads
 * the source and asserts the SHAPE: no `callInteractions` call in this file omits the proof. It fails on
 * the next branch that forgets, which is the mistake actually worth guarding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'server/connect/channels.ts'), 'utf8');

/** Each `callInteractions(env, communityId, <op>, { …args })` in this file, with its argument block. */
function calls(): Array<{ op: string; args: string }> {
  return [...SRC.matchAll(/callInteractions\(env, communityId, ([^,]+),\s*\{(.*?)\}\);/gs)]
    .map((m) => ({ op: m[1]!.trim(), args: m[2]! }));
}

describe('the steward proof travels with every channels call', () => {
  it('finds the calls at all (guards the reader itself)', () => {
    expect(calls().length).toBeGreaterThan(4);
  });

  it('no call omits `stewardship`', () => {
    const missing = calls().filter((c) => !c.args.includes('stewardship')).map((c) => c.op);
    expect(missing).toEqual([]);
  });

  it('posting a message carries it — the exact regression', () => {
    const post = calls().find((c) => c.op.includes("'channels.post'"));
    expect(post).toBeTruthy();
    expect(post!.args).toContain('stewardship');
  });
});
