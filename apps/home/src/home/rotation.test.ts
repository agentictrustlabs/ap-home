// Spec 410 §1.2 — the reviewed list is COMPUTED from both stores, classified by how each wire is signed, and the
// ceremony composes ONE batch: add → retire → approveDigest × (kept approved-digest wires + re-issued key-signed
// ones) → revoke × struck wires the Home holds. Chain, passkey and network are mocked at the module boundary; what
// is under test is the composition and the bookkeeping the person is told about.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { ROOT_AUTHORITY, hashDelegation, wireSigning } from '@agenticprimitives/delegation';
import { CHAIN_ID, CONTRACTS } from '../lib/chain';

const PERSON = '0x0a60000000000000000000000000000000000001' as Address;
const HOME_MCP_KEY = '0x0a60000000000000000000000000000000000002' as Address;
const SERVICE = '0x0a60000000000000000000000000000000000003' as Address;

const askAsMe = { delegator: PERSON, delegate: HOME_MCP_KEY, authority: ROOT_AUTHORITY, caveats: [], salt: '7', signature: `0x${'ab'.repeat(65)}` as Hex };
const askAsMeDigest = hashDelegation({ ...askAsMe, salt: 7n, caveats: [] }, CHAIN_ID, CONTRACTS.delegationManager);
const PLANE_DIGEST = `0x${'11'.repeat(32)}` as Hex;
const CONTACT_DIGEST = `0x${'22'.repeat(32)}` as Hex;
const REVOKED_DIGEST = `0x${'33'.repeat(32)}` as Hex;

const audit = { subject: PERSON, why: 'self', count: 2, total: 3, grants: [
  { kind: 'plane', holder: SERVICE, what: 'interactions grant', digest: PLANE_DIGEST, revoked: false, source: 'plane.interactions', signed: 'approved-digest' },
  { kind: 'contact', holder: '0x0a60000000000000000000000000000000000004', holderName: 'bob', what: 'contact (friend)', digest: CONTACT_DIGEST, revoked: false, source: 'contact:x', signed: 'key' },
  { kind: 'app', holder: 'old-app', what: 'reads', digest: REVOKED_DIGEST, revoked: true, source: 'read.grant', signed: 'approved-digest' },
] };

const fetchLog: Array<{ url: string; body?: unknown }> = [];
vi.mock('./grants-harness', () => ({ auditGrantsThroughHarness: async () => ({ ok: true, audit }) }));
vi.mock('../csrf', () => ({ ensureCsrfToken: async () => 't', csrfHeaders: () => ({}) }));
const rotateCalls: unknown[] = [];
vi.mock('../connect-client', () => ({
  rotationAvailability: () => ({ ok: true }),
  readCustodyMode: async () => 0,
  registerPasskeyCredentialRef: async () => ({ ref: { kind: 'passkey', credentialIdDigest: `0x${'ee'.repeat(32)}`, x: 1n, y: 2n, rpIdHash: `0x${'aa'.repeat(32)}` }, passkey: { credentialIdDigest: `0x${'ee'.repeat(32)}`, credentialIdB64: 'x', pubKeyX: 1n, pubKeyY: 2n, label: 'new' } }),
  rotateCredential: async (_p: Address, _s: unknown, input: unknown) => { rotateCalls.push(input); return { ok: true, txHash: '0xtx' }; },
}));
const stored: unknown[] = [];
vi.mock('../lib/passkey', () => ({
  loadPasskey: () => ({ credentialIdDigest: `0x${'dd'.repeat(32)}`, credentialIdB64: 'old', pubKeyX: 9n, pubKeyY: 8n, label: 'old' }),
  storePasskey: (p: unknown) => { stored.push(p); },
}));

beforeEach(() => {
  fetchLog.length = 0; rotateCalls.length = 0; stored.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchLog.push({ url, body });
    if (url === '/connect/app-grants' && (!init || init.method !== 'POST')) return new Response(JSON.stringify({ ok: true, grants: [{ clientId: 'home-mcp', appName: 'Claude', template: 'ask-as-me', delegate: HOME_MCP_KEY, delegation: askAsMe, validUntil: Date.now() + 1e6 }] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});

describe('reviewedList', () => {
  it('unions the agent audit (live rows only) with the Home app grants, classified by signing', async () => {
    const { reviewedList } = await import('./rotation');
    const r = await reviewedList({ person: PERSON, session: { token: 't' } });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const byDigest = Object.fromEntries(r.wires.map((w) => [w.digest.toLowerCase(), w]));
    expect(byDigest[PLANE_DIGEST]?.signed).toBe('approved-digest');
    expect(byDigest[CONTACT_DIGEST]?.signed).toBe('key');
    expect(byDigest[REVOKED_DIGEST]).toBeUndefined();
    const app = byDigest[askAsMeDigest.toLowerCase()];
    expect(app?.signed).toBe('key');
    expect(app?.clientId).toBe('home-mcp');
    expect(app?.wire).toEqual(askAsMe);
    expect(wireSigning(askAsMe)).toBe('key');
  });
});

describe('rotateThisDevicePasskey', () => {
  it('composes one batch: kept approved-digest wires re-approved, the app wire re-issued, the struck app wire revoked; lineage written; rows re-pointed', async () => {
    const { reviewedList, rotateThisDevicePasskey } = await import('./rotation');
    const list = await reviewedList({ person: PERSON, session: { token: 't' } });
    if (!list.ok) throw new Error('unreachable');
    // Keep the plane wire and the app wire; strike the contact (agent-held, key-signed → told, not revocable here).
    const keep = new Set([PLANE_DIGEST, askAsMeDigest.toLowerCase()]);
    const r = await rotateThisDevicePasskey({ person: PERSON, session: { token: 't' }, signHash: async () => '0x' as Hex, wires: list.wires, keep, label: 'new' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const input = rotateCalls[0] as { add: { kind: string }; retire: { kind: string; credentialIdDigest: Hex }; reapprove: Hex[]; revoke: unknown[] };
    expect(input.add.kind).toBe('passkey');
    expect(input.retire).toEqual({ kind: 'passkey', credentialIdDigest: `0x${'dd'.repeat(32)}` });
    // The plane wire by digest, the re-issued app wire by its (unchanged) digest; the contact is struck, not re-approved.
    expect(input.reapprove.map((d) => d.toLowerCase()).sort()).toEqual([PLANE_DIGEST, askAsMeDigest.toLowerCase()].sort());
    expect(input.revoke).toEqual([]);
    expect(r.outcome.reapproved).toBe(1);
    expect(r.outcome.reissued).toBe(1);
    expect(r.outcome.struck).toBe(1);
    expect(r.outcome.warnings.some((w) => /bob/.test(w) && /struck/.test(w))).toBe(true);
    // Lineage record written to the person's vault; the app-grant row re-pointed at the re-issued wire.
    const lineagePut = fetchLog.find((f) => f.url === `/a2a/interactions/${PERSON}/record.put`);
    expect(lineagePut?.body).toMatchObject({ recordType: `delegation.lineage:${askAsMeDigest.toLowerCase()}`, record: { type: 'ap.delegation-lineage.v1', supersedes: askAsMeDigest, reason: 'rotation' } });
    const repoint = fetchLog.find((f) => f.url === '/connect/app-grants' && (f.body as { delegation?: unknown })?.delegation);
    expect((repoint?.body as { delegation: { signature: string } }).delegation.signature).toBe('0x03');
    expect(fetchLog.some((f) => f.url === '/connect/passkey/link')).toBe(true);
    expect(stored).toEqual([]); // nothing to restore: the batch landed
  });
  it('a struck app wire is revoked in the batch and its row forgotten', async () => {
    const { reviewedList, rotateThisDevicePasskey } = await import('./rotation');
    const list = await reviewedList({ person: PERSON, session: { token: 't' } });
    if (!list.ok) throw new Error('unreachable');
    const r = await rotateThisDevicePasskey({ person: PERSON, session: { token: 't' }, signHash: async () => '0x' as Hex, wires: list.wires, keep: new Set([PLANE_DIGEST, CONTACT_DIGEST]), label: 'new' });
    expect(r.ok).toBe(true);
    const input = rotateCalls[0] as { reapprove: Hex[]; revoke: unknown[] };
    expect(input.revoke).toEqual([askAsMe]);
    // The kept contact is key-signed and only the agent holds its wire: re-approving its digest would do nothing,
    // so it is not in the batch and the person is told to re-authorize it from its screen.
    expect(input.reapprove.map((d) => d.toLowerCase())).toEqual([PLANE_DIGEST]);
    if (r.ok) expect(r.outcome.warnings.some((w) => /bob/.test(w) && /re-authorize/.test(w))).toBe(true);
    expect(fetchLog.some((f) => f.url === '/connect/app-grants' && (f.body as { revoked?: boolean })?.revoked === true)).toBe(true);
  });
  it('when the batch does not land, the OLD passkey is put back on this device and nothing else moves', async () => {
    vi.doMock('../connect-client', () => ({
      rotationAvailability: () => ({ ok: true }), readCustodyMode: async () => 0,
      registerPasskeyCredentialRef: async () => ({ ref: { kind: 'passkey', credentialIdDigest: `0x${'ee'.repeat(32)}`, x: 1n, y: 2n, rpIdHash: `0x${'aa'.repeat(32)}` }, passkey: { credentialIdDigest: `0x${'ee'.repeat(32)}`, credentialIdB64: 'x', pubKeyX: 1n, pubKeyY: 2n, label: 'new' } }),
      rotateCredential: async () => ({ ok: false, error: 'AA23 reverted' }),
    }));
    vi.resetModules();
    const { reviewedList, rotateThisDevicePasskey } = await import('./rotation');
    const list = await reviewedList({ person: PERSON, session: { token: 't' } });
    if (!list.ok) throw new Error('unreachable');
    const r = await rotateThisDevicePasskey({ person: PERSON, session: { token: 't' }, signHash: async () => '0x' as Hex, wires: list.wires, keep: new Set([PLANE_DIGEST]), label: 'new' });
    expect(r).toEqual({ ok: false, error: 'AA23 reverted' });
    expect(stored.length).toBe(1);
    expect((stored[0] as { label: string }).label).toBe('old');
    expect(fetchLog.some((f) => f.url.endsWith('/record.put'))).toBe(false);
    expect(fetchLog.some((f) => f.url === '/connect/passkey/link')).toBe(false);
  });
  it('a governed home is refused before anything is created', async () => {
    vi.doMock('../connect-client', () => ({ rotationAvailability: () => ({ ok: true }), readCustodyMode: async () => 2, registerPasskeyCredentialRef: async () => { throw new Error('must not be called'); }, rotateCredential: async () => ({ ok: true }) }));
    vi.resetModules();
    const { rotateThisDevicePasskey } = await import('./rotation');
    const r = await rotateThisDevicePasskey({ person: PERSON, session: { token: 't' }, signHash: async () => '0x' as Hex, wires: [], keep: new Set(), label: 'new' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/custody-governed/);
  });
});
