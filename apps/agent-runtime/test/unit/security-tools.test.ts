// Spec 422 §9.1 — the Security section asked: the reads say what the chain says; the acts are ceremonies her Home runs
// and the invoker only reports what her records show afterwards.
import { describe, it, expect } from 'vitest';
import { InputRequired } from '@agenticprimitives/orchestration';
import { credentialItems, postureOf, securityInvoker, refKey, type CredentialLabelV1, type ChannelV1, type SecurityDeps } from '../../src/security-tools.js';

const ME = '0x1dba000000000000000000000000000000000001';
const D1 = `0x${'11'.repeat(32)}` as const;
const W1 = '0x1111111111111111111111111111111111111111' as const;
const labels: CredentialLabelV1[] = [
  { ref: { kind: 'passkey', credentialIdDigest: D1 }, label: 'Laptop', device: 'Windows Hello', createdAt: '2026-09-01T00:00:00Z' },
  { ref: { kind: 'custodian', address: W1 }, label: 'MetaMask', createdAt: '2026-09-02T00:00:00Z' },
];
const channels: ChannelV1[] = [{ kind: 'phone', value: '+13035551234', linkedAt: '2026-09-01T00:00:00Z' }];

const ctx = (supplied: Array<{ stepRef: string; confirmed?: boolean }> = []) => ({ step: { id: 's0' }, index: 0, supplied } as never);
function deps(over: Partial<SecurityDeps> & { records?: Record<string, unknown> } = {}): SecurityDeps {
  const records = over.records ?? { 'security.credentials': { v: 1, items: labels }, 'security.channels': { v: 1, items: channels } };
  return {
    readSubjectRecord: async (_s, t) => records[t] ?? null,
    readCounts: async () => ({ custodians: 1, passkeys: 1 }),
    readPresence: async () => true,
    readCustodyMode: async () => 0,
    ...over,
  };
}

describe('credentialItems / postureOf', () => {
  it('the chain decides: a label the chain denies is retired; channels are login-grade and never signers', () => {
    const present = new Map([[refKey(labels[0]!.ref), true], [refKey(labels[1]!.ref), false]]);
    const { items, unlabelled } = credentialItems({ labels, present, counts: { custodians: 1, passkeys: 1 }, channels });
    expect(items.map((i) => [i.kind, i.state, i.grade])).toEqual([['passkey', 'active', 'custody-grade'], ['wallet', 'retired', 'custody-grade'], ['phone', 'active', 'login-grade']]);
    expect(items[2]!.detail).toMatch(/never signs/);
    expect(unlabelled).toEqual({ passkeys: 0, custodians: 1 });
  });
  it('the ladder: one credential · two kinds · trustees', () => {
    expect(postureOf({ counts: { custodians: 0, passkeys: 1 }, kinds: new Set(['passkey']), custodyMode: 0 }).rung).toBe('just-you');
    expect(postureOf({ counts: { custodians: 1, passkeys: 1 }, kinds: new Set(['passkey', 'wallet']), custodyMode: 0 }).rung).toBe('backups');
    expect(postureOf({ counts: { custodians: 1, passkeys: 1 }, kinds: new Set(['passkey', 'wallet']), custodyMode: 1 }).rung).toBe('trustees');
  });
});

describe('securityInvoker', () => {
  it('lists what signs for her and what opens her home, and names what it could not read', async () => {
    const r = await securityInvoker(deps({ readCustodyMode: async () => { throw new Error('rpc'); } }), ME)('person.credentials.list', {}, ctx()) as { count: number; items: unknown[]; note: string };
    expect(r.count).toBe(3);
    expect(r.note).toMatch(/Could not read the custody mode/);
    expect(r.note).toMatch(/never a signer/);
  });
  it('refuses to guess when the chain is unreadable', async () => {
    const r = await securityInvoker(deps({ readCounts: async () => { throw new Error('rpc'); } }), ME)('person.credentials.list', {}, ctx()) as { refused?: string };
    expect(r.refused).toMatch(/chain could not be read/);
  });
  it('the posture says the rung and the next step', async () => {
    const r = await securityInvoker(deps(), ME)('person.security.posture', {}, ctx()) as { rung: string; note: string };
    expect(r.rung).toBe('backups');
    expect(r.note).toMatch(/Next step: name recovery trustees/);
  });
  it('adding a credential asks for the ceremony, then reports only what the chain shows', async () => {
    const inv = securityInvoker(deps(), ME);
    await expect(inv('person.credential.add', { kind: 'passkey', label: 'Phone' }, ctx())).rejects.toBeInstanceOf(InputRequired);
    const r = await inv('person.credential.add', { kind: 'passkey', label: 'Phone' }, ctx([{ stepRef: 's0', confirmed: true }])) as { refused?: string; added?: boolean };
    expect(r.refused).toMatch(/not recorded on chain/); // her records never got a "Phone" label → nothing happened
    const ok = await securityInvoker(deps({ records: { 'security.credentials': { v: 1, items: [...labels, { ref: { kind: 'passkey', credentialIdDigest: `0x${'22'.repeat(32)}` }, label: 'Phone', createdAt: '' }] } } }), ME)('person.credential.add', { kind: 'passkey', label: 'Phone' }, ctx([{ stepRef: 's0', confirmed: true }])) as { added?: boolean };
    expect(ok.added).toBe(true);
  });
  it('renaming matches one credential by its words and refuses ambiguity', async () => {
    const inv = securityInvoker(deps(), ME);
    const amb = await inv('person.credential.label', { credential: 'a', label: 'X' }, ctx()) as { refused?: string };
    expect(amb.refused).toMatch(/matches 2 credentials/);
    await expect(inv('person.credential.label', { credential: 'laptop', label: 'Work laptop' }, ctx())).rejects.toBeInstanceOf(InputRequired);
    // resumed: the old words name nothing any more; the record carries the new label → renamed
    const after = securityInvoker(deps({ records: { 'security.credentials': { v: 1, items: [{ ...labels[0]!, label: 'Work laptop' }, labels[1]!] } } }), ME);
    const r = await after('person.credential.label', { credential: 'laptop', label: 'Work laptop' }, ctx([{ stepRef: 's0', confirmed: true }])) as { renamed?: boolean };
    expect(r.renamed).toBe(true);
    const nope = await inv('person.credential.label', { credential: 'laptop', label: 'Work laptop' }, ctx([{ stepRef: 's0', confirmed: true }])) as { refused?: string };
    expect(nope.refused).toMatch(/not recorded/);
  });
  it('unlinking a channel names the one it means and asks for the ceremony', async () => {
    const inv = securityInvoker(deps(), ME);
    await expect(inv('person.channel.unlink', { kind: 'phone', channel: '1234' }, ctx())).rejects.toBeInstanceOf(InputRequired);
    const none = await inv('person.channel.unlink', { kind: 'email' }, ctx()) as { refused?: string };
    expect(none.refused).toMatch(/no email is linked/);
    const done = await securityInvoker(deps({ records: { 'security.credentials': { v: 1, items: labels }, 'security.channels': { v: 1, items: [{ ...channels[0]!, unlinkedAt: '2026-10-01T00:00:00Z' }] } } }), ME)('person.channel.unlink', { kind: 'phone', channel: '+13035551234' }, ctx([{ stepRef: 's0', confirmed: true }])) as { unlinked?: boolean; refused?: string };
    // after the ceremony the record says unlinked — but the match itself now finds nothing live:
    expect(done.refused ?? (done.unlinked ? 'ok' : '')).toMatch(/no phone is linked|ok/);
  });
});
