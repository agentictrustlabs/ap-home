import { describe, it, expect } from 'vitest';
import { mintCode, parsePairingOptions, claim, complete, take, isExpired, PAIRING_CODE_RE, PAIRING_TAKE_TTL_MS, type PairingStateV1 } from '../src/runtime-pairing.js';

const opts = parsePairingOptions({ member: 'goose-3.svc', workspace: 'missio-nexus.org', openMandate: ['messaging.direct.send'], messagingTo: ['0x' + 'a'.repeat(40)], wake: 'container' })!;
const minted = (): PairingStateV1 => ({ v: 1, code: 'alice-ABCDEF', state: 'minted', options: opts, mintedAt: new Date(0).toISOString(), expiresAt: new Date(15 * 60_000).toISOString() });
const KEY = '0x' + 'b'.repeat(40);

describe('runtime pairing (spec 400 W1b)', () => {
  it('a code names the handle and reads aloud', () => {
    const c = mintCode('alice.me', (n) => new Uint8Array(n).fill(7));
    expect(c).toMatch(PAIRING_CODE_RE);
    expect(c.startsWith('alice-')).toBe(true);
    expect(mintCode('alice.me', (n) => new Uint8Array(n).fill(0))).not.toMatch(/[0O1IL]/);
  });
  it('options are checked: a .svc member, an org-class workspace, a sane window', () => {
    expect(opts.wake).toBe('container');
    expect(parsePairingOptions({ member: 'goose', workspace: 'x.org' })).toBeNull();
    expect(parsePairingOptions({ member: 'goose.svc', workspace: 'x.org', validForSeconds: 10 })).toBeNull();
    expect(parsePairingOptions({ member: 'goose.svc', workspace: 'x.org', wake: { url: 'ftp://x' } })).toBeNull();
    expect(parsePairingOptions({ member: 'goose.svc', workspace: 'x.org' })!.wake).toBe('poll');
  });
  it('minted → claimed → completed → taken, forward only, by the one key', () => {
    const p = minted();
    const c = claim(p, { address: KEY, agent: 'claude-code-acp' }, 1000);
    expect(c.ok && c.next.state).toBe('claimed');
    const again = claim(c.ok ? c.next : p, { address: KEY }, 2000);
    expect(again.ok).toBe(true);
    const other = claim(c.ok ? c.next : p, { address: '0x' + 'c'.repeat(40) }, 2000);
    expect(other.ok).toBe(false);
    const early = take(c.ok ? c.next : p, KEY, 2000);
    expect(early.ok && early.state).toBe('claimed');
    expect(complete(c.ok ? c.next : p, { address: '0x' + 'c'.repeat(40) }, 3000).ok).toBe(false);
    const done = complete(c.ok ? c.next : p, { address: KEY, name: 'goose-3.svc' }, 3000);
    expect(done.ok && done.next.state).toBe('completed');
    expect(take(done.ok ? done.next : p, '0x' + 'c'.repeat(40), 4000).ok).toBe(false);
    const t = take(done.ok ? done.next : p, KEY, 4000);
    expect(t.ok && t.state === 'completed' && t.record?.name).toBe('goose-3.svc');
    expect(t.ok && t.next?.state).toBe('taken');
    expect(take(t.ok && t.next ? t.next : p, KEY, 5000).ok).toBe(false);
    expect(complete(p, { address: KEY }, 3000).ok).toBe(false);
  });
  it('a code expires; a completed record waits its own window', () => {
    const p = minted();
    expect(isExpired(p, 16 * 60_000)).toBe(true);
    expect(claim(p, { address: KEY }, 16 * 60_000).ok).toBe(false);
    const c = claim(p, { address: KEY }, 1000); const done = complete(c.ok ? c.next : p, { address: KEY }, 2000);
    expect(isExpired(done.ok ? done.next : p, 2000 + PAIRING_TAKE_TTL_MS + 1)).toBe(true);
    expect(isExpired(done.ok ? done.next : p, 2000 + PAIRING_TAKE_TTL_MS - 1)).toBe(false);
  });
});
