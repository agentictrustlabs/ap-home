/**
 * `/connect/household-stewards` — the roster a steward or member reads, and the steward invitation's three writes.
 * The bearer verifier is stubbed (the test names the person and whether it is a Home session); the chain check is a
 * seam; everything else — the KV rows and the handlers — is the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG = '0x' + '1'.repeat(40), A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let caller = { person: A, via: 'session' as 'session' | 'app' };
vi.mock('../_lib/person-bearer', () => ({ personFromBearer: async () => ({ ...caller, token: 't' }) }));
vi.mock('../_lib/verify-stewardship', () => ({ verifyStewardship: async () => false }));
vi.mock('../lib/relationships-doc', () => ({ mergeRelationshipEntry: async () => {} }));

import { handleGet, handlePost } from './household-stewards';

const wire = (to: string) => ({ delegator: ORG, delegate: to, signature: '0x' + to.slice(2, 6), caveats: [] });
let store: Map<string, string>;
let revoked: Set<string>;
const verify = async (org: string, person: string, w: unknown) => org === ORG && (w as { delegate?: string })?.delegate === person && !revoked.has(person);
const merged: unknown[] = [];
// a member-access grant verifies when the household signed it to that person (the test's stand-in for the ERC-1271 read)
const verifyMember = async (g: { delegator?: string; delegate?: string; signature?: string }) => g?.delegator === ORG && !!g?.signature && !revoked.has(String(g.delegate));
const deps = { verify, verifyMember, now: () => 100, merge: async (_e: unknown, _p: string, _t: string, entry: unknown) => { merged.push(entry); } };
const env = () => ({ AUTH_CODES: { async get(k: string) { return store.get(k) ?? null; }, async put(k: string, v: string) { store.set(k, v); }, async delete(k: string) { store.delete(k); } } }) as never;
const get = async () => { const r = await handleGet({ request: new Request(`https://home.test/connect/household-stewards?org=${ORG}`, { headers: { authorization: 'Bearer t' } }), env: env() }, deps); return { status: r.status, body: await r.json() as Record<string, any> }; };
const post = async (body: unknown) => { const r = await handlePost({ request: new Request('https://home.test/connect/household-stewards', { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env: env() }, deps); return { status: r.status, body: await r.json() as Record<string, any> }; };
const as = (person: string, via: 'session' | 'app' = 'session') => { caller = { person, via }; };

beforeEach(() => {
  revoked = new Set(); merged.length = 0;
  store = new Map([
    [`related:${A}:${ORG}`, JSON.stringify({ orgAgent: ORG, orgName: 'Pedersen household', kind: 'household', relationship: 'steward', stewardshipDelegation: wire(A) })],
    [`related:${B}:${ORG}`, JSON.stringify({ orgAgent: ORG, orgName: 'Pedersen household', kind: 'household', relationship: 'member', memberAccessDelegation: wire(B), requestedBy: 'family-field-join' })],
    [`delegated-idx:${ORG}`, JSON.stringify([{ orgAgent: B, orgName: 'Barbara' }])],
  ]);
});

describe('GET the roster', () => {
  it('a steward reads it; the founder is recorded on it as a verified steward; a member is listed as a member', async () => {
    as(A, 'app');
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.you).toBe('steward');
    expect(body.people).toEqual([{ agent: A, relationship: 'steward', verified: true, via: 'stewardship-wire', since: 100 }, { agent: B, relationship: 'member', verified: false, via: 'membership' }]);
  });
  it('a member reads it too; a stranger is refused; an invitee sees only their own invitation', async () => {
    as(B, 'app');
    expect((await get()).body.you).toBe('member');
    as(C, 'app');
    expect(await get()).toMatchObject({ status: 403, body: { code: 'not_in_household' } });
    as(A); await post({ action: 'invite', org: ORG, invitee: C, label: 'Cara', delegation: wire(C) });
    as(C, 'app');
    const { body } = await get();
    expect(body.you).toBe('invited');
    expect(body.invitations).toEqual([expect.objectContaining({ invitee: C, state: 'pending' })]);
    expect(body.invitations[0]).not.toHaveProperty('delegation');
  });
});

describe('the steward invitation', () => {
  it('an app cannot invite or accept: a Home session is required', async () => {
    as(A, 'app');
    expect(await post({ action: 'invite', org: ORG, invitee: B, delegation: wire(B) })).toMatchObject({ status: 403, body: { code: 'session_required' } });
  });
  it('invite → accept makes the member a steward: link, roster, and the person’s relationships doc', async () => {
    as(A);
    expect((await post({ action: 'invite', org: ORG, invitee: B, label: 'Barbara', delegation: wire(B) })).body.invitation).toMatchObject({ state: 'pending', invitedBy: A });
    as(B);
    expect(await post({ action: 'accept', org: ORG })).toMatchObject({ status: 200, body: { relationship: 'steward' } });
    const link = JSON.parse(store.get(`related:${B}:${ORG}`)!);
    expect(link).toMatchObject({ relationship: 'steward', stewardshipDelegation: wire(B), kind: 'household', requestedBy: 'family-field-join' });
    expect(merged).toEqual([expect.objectContaining({ org: ORG, relationship: 'steward', delegations: [wire(B)] })]);
    as(A, 'app');
    const { body } = await get();
    expect(body.people.filter((p: { relationship: string }) => p.relationship === 'steward').map((p: { agent: string }) => p.agent)).toEqual([A, B]);
    expect(body.invitations).toEqual([expect.objectContaining({ invitee: B, state: 'accepted', acceptedAt: 100 })]);
    // inviting an existing steward again is refused; cancelling an accepted one needs the grant revoked
    as(A);
    expect((await post({ action: 'invite', org: ORG, invitee: B, delegation: wire(B) })).body.code).toBe('already_steward');
    expect((await post({ action: 'cancel', org: ORG, invitee: B })).body.code).toBe('revoke_required');
  });
  it('a member cannot invite; a grant to someone else is refused; a lapsed grant cannot be accepted', async () => {
    as(B);
    expect((await post({ action: 'invite', org: ORG, invitee: C, delegation: wire(C) })).body.code).toBe('not_a_steward');
    as(A);
    expect((await post({ action: 'invite', org: ORG, invitee: C, delegation: wire(B) })).body.code).toBe('not_a_stewardship_grant');
    await post({ action: 'invite', org: ORG, invitee: C, delegation: wire(C) });
    revoked.add(C);
    as(C);
    expect((await post({ action: 'accept', org: ORG })).body.code).toBe('invitation_lapsed');
  });
  it('a revoked steward reads as lapsed, not a steward', async () => {
    as(A); await post({ action: 'invite', org: ORG, invitee: B, delegation: wire(B) });
    as(B); await post({ action: 'accept', org: ORG });
    revoked.add(B);
    as(A, 'app');
    const { body } = await get();
    expect(body.lapsed).toEqual([B]);
    expect(body.people.find((p: { agent: string }) => p.agent === B)).toMatchObject({ relationship: 'member' });
  });
  it('a pending invitation is cancelled by a steward', async () => {
    as(A); await post({ action: 'invite', org: ORG, invitee: C, delegation: wire(C) });
    expect((await post({ action: 'cancel', org: ORG, invitee: C })).body.invitation.state).toBe('cancelled');
  });
});

describe('membership is the household\'s grant, never the person\'s own note (RUNC-2)', () => {
  beforeEach(() => { store = new Map(); revoked = new Set(); caller = { person: C, via: 'session' }; });
  it('a self-written member link with no household grant reads nothing', async () => {
    store.set(`related:${C}:${ORG}`, JSON.stringify({ orgAgent: ORG, relationship: 'member' }));
    const r = await handleGet({ request: new Request(`https://home.test/connect/household-stewards?org=${ORG}`, { headers: { authorization: 'Bearer t' } }), env: env() }, deps);
    expect(r.status).toBe(403);
  });
  it('self-appending to the household member index reads nothing', async () => {
    store.set(`delegated-idx:${ORG}`, JSON.stringify([{ orgAgent: C, orgName: 'me', delegation: { delegator: C, delegate: ORG, signature: '0x1', caveats: [] } }]));
    const r = await handleGet({ request: new Request(`https://home.test/connect/household-stewards?org=${ORG}`, { headers: { authorization: 'Bearer t' } }), env: env() }, deps);
    expect(r.status).toBe(403);
  });
  it('a grant the person signed themselves is not a member grant', async () => {
    store.set(`related:${C}:${ORG}`, JSON.stringify({ orgAgent: ORG, relationship: 'member', memberAccessDelegation: { delegator: C, delegate: C, signature: '0x1', caveats: [] } }));
    const r = await handleGet({ request: new Request(`https://home.test/connect/household-stewards?org=${ORG}`, { headers: { authorization: 'Bearer t' } }), env: env() }, deps);
    expect(r.status).toBe(403);
  });
  it('the household\'s member-access grant to them reads the roster', async () => {
    store.set(`related:${C}:${ORG}`, JSON.stringify({ orgAgent: ORG, relationship: 'member', memberAccessDelegation: wire(C) }));
    const r = await handleGet({ request: new Request(`https://home.test/connect/household-stewards?org=${ORG}`, { headers: { authorization: 'Bearer t' } }), env: env() }, deps);
    expect(r.status).toBe(200);
  });
});
