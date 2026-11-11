import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { pairingProofDigest } from '@agenticprimitives/runtime-member';
import { mintCode, parsePairingOptions, claim, complete, take, isExpired, checkProof, noteMiss, confirmationOf, pairingConfirmation, PAIRING_CODE_RE, PAIRING_TAKE_TTL_MS, type PairingStateV1 } from '../src/runtime-pairing.js';

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

  // RUNB-12 (spec 445) — what binds a short code.
  it('RUNB-12: a claim signed by the key it names passes; another key, another Home, another move or a stale proof does not', async () => {
    const key = generatePrivateKey(); const address = privateKeyToAccount(key).address;
    const code = 'goose-ABCDEF'; const home = 'https://home.example';
    const now = Date.now(); const issuedAt = Math.floor(now / 1000);
    const proofFor = async (move: 'claim' | 'take', h = home, k = key, at = issuedAt) => ({ issuedAt: at, signature: await sign({ hash: pairingProofDigest({ move, code, address, home: h, issuedAt: at }), privateKey: k, to: 'hex' as const }) });
    expect(await checkProof('claim', { code, address, home, proof: await proofFor('claim') }, now)).toBeNull();
    expect(await checkProof('claim', { code, address, home })).toMatch(/no proof/);
    expect(await checkProof('claim', { code, address, home, proof: await proofFor('claim', home, generatePrivateKey()) }, now)).toMatch(/not signed by the key/);
    expect(await checkProof('claim', { code, address, home, proof: await proofFor('claim', 'https://other.example') }, now)).toMatch(/not signed by the key/);
    expect(await checkProof('take', { code, address, home, proof: await proofFor('claim') }, now)).toMatch(/not signed by the key/);
    expect(await checkProof('claim', { code, address, home, proof: await proofFor('claim', home, key, issuedAt - 600) }, now)).toMatch(/not fresh/);
    expect(await checkProof('claim', { code, address, proof: await proofFor('claim') }, now)).toMatch(/Home/);
  });
  it('RUNB-12: the confirmation is the one the runtime derives, and a stranger\'s key shows another', () => {
    const p = minted();
    const mine = '0x1111111111111111111111111111111111111111'; const theirs = '0x2222222222222222222222222222222222222222';
    expect(confirmationOf(p)).toBeUndefined();
    const claimed = claim(p, { address: mine }, 1000);
    expect(claimed.ok && confirmationOf(claimed.next)).toBe(pairingConfirmation(p.code, mine));
    const stranger = claim(p, { address: theirs }, 1000);
    expect(stranger.ok && confirmationOf(stranger.next)).not.toBe(pairingConfirmation(p.code, mine));
  });
  it('RUNB-12: the fifth miss voids; an old miss is forgotten', () => {
    let l: unknown = null; let voided = false;
    for (let i = 0; i < 5; i++) { const r = noteMiss(l, 1000 + i); l = r.ledger; voided = r.void; }
    expect(voided).toBe(true);
    expect(noteMiss(l, 1000 + 20 * 60_000).void).toBe(false);
  });
});
