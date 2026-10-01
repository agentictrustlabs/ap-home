// Spec 422 §3.1 — the credential set is a JOIN: the chain decides what signs, the vault only labels it.
import { describe, it, expect } from 'vitest';
import { joinCredentialSet, maskChannel, refKey, type CredentialLabelV1 } from './credentials';

const D1 = `0x${'11'.repeat(32)}` as const;
const D2 = `0x${'22'.repeat(32)}` as const;
const W1 = '0x1111111111111111111111111111111111111111' as const;
const CSUB = '0x2222222222222222222222222222222222222222' as const;

const labels: CredentialLabelV1[] = [
  { ref: { kind: 'passkey', credentialIdDigest: D1 }, label: 'Laptop', device: 'Windows Hello', createdAt: '2026-09-01T00:00:00Z' },
  { ref: { kind: 'passkey', credentialIdDigest: D2 }, label: 'Old phone', createdAt: '2026-08-01T00:00:00Z', state: 'retired', retiredAt: '2026-09-20T00:00:00Z' },
  { ref: { kind: 'custodian', address: W1 }, label: 'MetaMask', createdAt: '2026-09-02T00:00:00Z' },
  { ref: { kind: 'custodian', address: CSUB }, label: 'Google sign-in', method: 'google', createdAt: '' },
];

describe('joinCredentialSet', () => {
  it('a label the chain confirms is active; a label the chain denies is retired whatever it says', () => {
    const present = new Map([[refKey(labels[0]!.ref), true], [refKey(labels[1]!.ref), false], [refKey(labels[2]!.ref), true], [refKey(labels[3]!.ref), true]]);
    const set = joinCredentialSet({ labels, present, counts: { passkeys: 1, custodians: 2 }, thisDevice: { credentialIdDigest: D1, label: 'Laptop' }, channels: [], custodyMode: 0 });
    const byKey = Object.fromEntries(set.rows.map((r) => [r.key, r]));
    expect(byKey[refKey(labels[0]!.ref)]).toMatchObject({ state: 'active', thisDevice: true, kind: 'passkey', sub: 'This device', grade: 'custody-grade' });
    expect(byKey[refKey(labels[1]!.ref)]).toMatchObject({ state: 'retired', onChain: false });
    expect(byKey[refKey(labels[2]!.ref)]).toMatchObject({ state: 'active', kind: 'wallet' });
    expect(byKey[refKey(labels[3]!.ref)]).toMatchObject({ state: 'active', kind: 'server-key', sub: 'Server-secured key for your Google sign-in' });
    expect(set.unlabelled).toEqual({ passkeys: 0, custodians: 0 });
  });

  it('a retired label the chain STILL holds is active — a retirement that did not happen is not hidden', () => {
    const present = new Map([[refKey(labels[1]!.ref), true]]);
    const set = joinCredentialSet({ labels: [labels[1]!], present, counts: { passkeys: 1, custodians: 0 }, thisDevice: null, channels: [], custodyMode: 0 });
    expect(set.rows[0]).toMatchObject({ state: 'active', onChain: true });
  });

  it('chain entries no label reaches are counted as unlabelled, never invented as rows', () => {
    const set = joinCredentialSet({ labels: [], present: new Map(), counts: { passkeys: 2, custodians: 1 }, thisDevice: null, channels: [], custodyMode: 0 });
    expect(set.rows).toEqual([]);
    expect(set.unlabelled).toEqual({ passkeys: 2, custodians: 1 });
  });

  it("this device's unlabelled passkey appears as a row named for what it is, and counts against the unlabelled passkeys", () => {
    const present = new Map([[refKey({ kind: 'passkey', credentialIdDigest: D1 }), true]]);
    const set = joinCredentialSet({ labels: [], present, counts: { passkeys: 1, custodians: 0 }, thisDevice: { credentialIdDigest: D1, label: 'Rich passkey' }, channels: [], custodyMode: 0 });
    expect(set.rows).toHaveLength(1);
    expect(set.rows[0]).toMatchObject({ thisDevice: true, label: 'Rich passkey', state: 'active' });
    expect(set.unlabelled.passkeys).toBe(0);
  });

  it('channels are login-grade rows, masked, and an unlinked channel is gone', () => {
    const set = joinCredentialSet({ labels: [], present: new Map(), counts: { passkeys: 0, custodians: 1 }, thisDevice: null, channels: [
      { kind: 'email', value: 'rich@example.org', linkedAt: '2026-09-01T00:00:00Z' },
      { kind: 'phone', value: '+13035551234', linkedAt: '2026-09-01T00:00:00Z' },
      { kind: 'phone', value: '+13035550000', linkedAt: '2026-08-01T00:00:00Z', unlinkedAt: '2026-09-01T00:00:00Z' },
    ], custodyMode: 0 });
    expect(set.rows.map((r) => [r.grade, r.kind, r.sub])).toEqual([
      ['login-grade', 'email', 'ri…@example.org'],
      ['login-grade', 'phone', '…1234'],
    ]);
  });

  it('orders: this device, other active custody, channels, retired', () => {
    const present = new Map([[refKey(labels[0]!.ref), true], [refKey(labels[2]!.ref), true]]);
    const set = joinCredentialSet({ labels: [labels[1]!, labels[2]!, labels[0]!], present, counts: { passkeys: 1, custodians: 1 }, thisDevice: { credentialIdDigest: D1, label: 'Laptop' }, channels: [{ kind: 'email', value: 'a@b.c', linkedAt: '' }], custodyMode: 0 });
    expect(set.rows.map((r) => r.kind)).toEqual(['passkey', 'wallet', 'email', 'passkey']);
    expect(set.rows[3]!.state).toBe('retired');
  });

  it('maskChannel never shows the whole value', () => {
    expect(maskChannel({ kind: 'email', value: 'richard@x.org', linkedAt: '' })).toBe('ri…@x.org');
    expect(maskChannel({ kind: 'phone', value: '(303) 555-1234', linkedAt: '' })).toBe('…1234');
  });
});
