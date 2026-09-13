// Contacts — membership on the person agent (spec 401 C1): the person's own act, on their own records.
import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { InputRequired } from '@agenticprimitives/orchestration';
import { contactInviteInvoker, contactListInvoker, contactRemoveInvoker, contactRecordType, CONTACT_RESOURCE_SCOPE, type ContactDeps, type ContactRecordV1 } from '../src/contacts.js';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b1' as Address;
const GOOSE = '0x00000000000000000000000000000000000000d1' as Address;
const TS = '0x00000000000000000000000000000000000000e1' as Address;
const VAL = '0x00000000000000000000000000000000000000e2' as Address;
const DB = '0x00000000000000000000000000000000000000e3' as Address;
const store = new Map<string, unknown>();
const deps = (over: Partial<ContactDeps> = {}): ContactDeps => ({
  env: { CHAIN_ID: '34348', DELEGATION_MANAGER: '0x00000000000000000000000000000000000000dd', HARNESS_AGENT_SA: '0x00000000000000000000000000000000000000ee' },
  enforcers: { timestamp: TS, value: VAL, digestBinding: DB }, vaultServerId: 'demo-mcp',
  readSubjectRecord: async (s, t) => (s === ALICE ? store.get(t) ?? null : null),
  writeSubjectRecord: async (s, t, r) => { if (s !== ALICE) return { ok: false, error: 'not yours' }; store.set(t, r); return { ok: true }; },
  survey: async (s) => (s === ALICE ? [...store.keys()].map((recordType) => ({ recordType })) : []),
  readRecords: async (s, keys) => (s === ALICE ? Object.fromEntries(keys.map((k) => [k, store.get(k)])) : {}),
  nameOf: async (a) => ({ [BOB]: 'bob.me', [GOOSE]: 'goose-1.svc' } as Record<string, string>)[a] ?? null,
  agentTypeOf: async (a) => (a === BOB ? 'person' : a === GOOSE ? 'service' : a === '0x00000000000000000000000000000000000000c1' ? 'org' : null),
  sendDirectMessage: async () => ({ ok: true, messageId: 'm1' }),
  executeAsServiceSa: async () => ({ txHash: '0xtx' }),
  digestBindingArgsFor: () => '0x' as Hex, stepDigests: (_a, intent) => ({ intent }),
  ...over,
});
const wire = (delegator: Address) => ({ ref: '0xref', wire: { delegator, delegate: '0x00000000000000000000000000000000000000ee', authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: TS, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1000n, 2000n]), args: '0x' }], salt: 1n, signature: '0xsig' } });
const ctx = (supplied: unknown[] = []) => ({ step: { id: 's0' }, index: 0, intent: { goal: 'add bob', context: {} }, supplied } as never);

describe('person.contact.invite', () => {
  it('asks for the grant signature, then records the contact with its role and tells them', async () => {
    const inv = contactInviteInvoker(deps(), wire(ALICE), ALICE, 'sess');
    const asked = await inv('person.contact.invite', { contact: BOB, role: 'friend' }, ctx()).catch((e: unknown) => e) as InputRequired & { request?: { kind?: string; digest?: string } };
    expect(asked).toBeInstanceOf(InputRequired);
    const digest = String((asked as unknown as { request: { digest: string } }).request?.digest ?? (asked as unknown as { digest: string }).digest);
    const out = (await inv('person.contact.invite', { contact: BOB, role: 'friend' }, ctx([{ stepRef: 's0', signature: { digest, signature: '0xgrant' } }]))) as { added: boolean; role: string; told: { ok: boolean }; note: string };
    expect(out.added).toBe(true); expect(out.role).toBe('friend'); expect(out.told.ok).toBe(true); expect(out.note).toMatch(/mutual/);
    const rec = store.get(contactRecordType(BOB)) as ContactRecordV1;
    expect(rec.type).toBe('ap.contact.v1'); expect(rec.status).toBe('contact'); expect(rec.mutual).toBe(false);
    expect(rec.delegation.delegator).toBe(ALICE); expect(rec.delegation.delegate).toBe(BOB);
  });
  it('a service contact (a runtime, a coach) is one-way — no mutual flag; an organization is refused; not under another\'s mandate', async () => {
    const inv = contactInviteInvoker(deps(), wire(ALICE), ALICE, 'sess');
    const asked = await inv('person.contact.invite', { contact: GOOSE, role: 'runtime' }, ctx()).catch((e: unknown) => e) as unknown as { request?: { digest: string }; digest?: string };
    const digest = String(asked.request?.digest ?? asked.digest);
    const out = (await inv('person.contact.invite', { contact: GOOSE, role: 'runtime' }, ctx([{ stepRef: 's0', signature: { digest, signature: '0xg' } }]))) as { added: boolean; role: string };
    expect(out.role).toBe('runtime'); expect((store.get(contactRecordType(GOOSE)) as ContactRecordV1).mutual).toBeUndefined();
    await expect(inv('person.contact.invite', { contact: '0x00000000000000000000000000000000000000c1' }, ctx())).rejects.toThrow(/not a contact/);
    await expect(contactInviteInvoker(deps(), wire(BOB), ALICE, 'sess')('person.contact.invite', { contact: BOB }, ctx())).rejects.toThrow(/your own mandate/);
  });
  it('is idempotent: adding a contact again changes nothing', async () => {
    const out = (await contactInviteInvoker(deps(), wire(ALICE), ALICE, 'sess')('person.contact.invite', { contact: BOB }, ctx())) as { added: boolean; alreadyContact: boolean };
    expect(out.added).toBe(false); expect(out.alreadyContact).toBe(true);
  });
});

describe('person.contact.list / remove', () => {
  it('lists the person\'s own contacts with names and roles', async () => {
    const out = (await contactListInvoker(deps(), ALICE)('person.contact.list', {}, ctx())) as { count: number; contacts: Array<{ name: string | null; role: string }> };
    expect(out.count).toBe(2);
    expect(out.contacts.map((c) => `${c.name}:${c.role}`).sort()).toEqual(['bob.me:friend', 'goose-1.svc:runtime']);
    expect((await contactListInvoker(deps(), BOB)('person.contact.list', {}, ctx())) as { count: number }).toMatchObject({ count: 0 });
  });
  it('remove revokes the grant on chain under the person\'s mandate and marks the record removed; the list drops it', async () => {
    const calls: string[] = [];
    const out = (await contactRemoveInvoker(deps({ executeAsServiceSa: async (sa, data) => { calls.push(`${sa}:${data.slice(0, 10)}`); return { txHash: '0xrevoked' }; } }), wire(ALICE), ALICE)('person.contact.remove', { contact: BOB }, ctx())) as { removed: boolean; txHash: string };
    expect(out.removed).toBe(true); expect(out.txHash).toBe('0xrevoked'); expect(calls).toHaveLength(1);
    expect((store.get(contactRecordType(BOB)) as ContactRecordV1).status).toBe('removed');
    const list = (await contactListInvoker(deps(), ALICE)('person.contact.list', {}, ctx())) as { count: number; removed: number };
    expect(list.count).toBe(1); expect(list.removed).toBe(1);
    expect((await contactRemoveInvoker(deps(), wire(ALICE), ALICE)('person.contact.remove', { contact: BOB }, ctx())) as { removed: boolean }).toMatchObject({ removed: false });
  });
  it('the grant is scoped to the contact profile, read-only', () => {
    expect(CONTACT_RESOURCE_SCOPE).toBe('vault:profile.contact');
  });
});
