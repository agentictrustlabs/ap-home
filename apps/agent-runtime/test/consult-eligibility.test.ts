// Spec 445 §3.4 (fabric audit DATB-3) — WHO MAY BE CONSULTED is current member ∩ live grant ∩ topic participants,
// and the two sets come from two sources.
//
// The precondition the audit confirmed here: `internal.consult.eligible` handed the consult GRANT store's keys to
// fabric as the member list, with no membership read. A grant is the member's consent; the organization cannot
// revoke it and it outlives a departure — so a person who had left, or been removed, was still sent the question,
// the topic's title and its recent conversation.
//
// The membership source is the organization's own: its `org.membership:member:<sa>` record (re-checked on chain),
// else a current signed listing — the tests the board's admission gate applies — and a record stamped `endedAt`
// is not overridden by a listing that was never cleaned up. Driven against the REAL methods; only the vault, the
// signature check and the chain are answered here.
import { describe, expect, it } from 'vitest';
import { consultGrantRecordKey } from '@agenticprimitives/fabric/messaging';
import { InteractionsDO } from '../src/interactions-do.js';
import { submitConsult, ConsultNotEligibleError } from '../src/consult-rail.js';

const ORG = '0x1111111111111111111111111111111111111111';
const CAROL = '0x2222222222222222222222222222222222222222';   // current member, by the organization's record
const BOB = '0x3333333333333333333333333333333333333333';     // LEFT — record ended, listing never cleaned up
const DAVE = '0x4444444444444444444444444444444444444444';    // holds a grant, was never a member
const ERIN = '0x5555555555555555555555555555555555555555';    // current member by listing only (pre-382)
const FRAN = '0x6666666666666666666666666666666666666666';    // current member, never opted in
const CHAIN = 84532;
const caip = (a: string) => `eip155:${CHAIN}:${a}`;
const wire = (from: string, to: string) => ({ delegator: from, delegate: to, authority: `0x${'ff'.repeat(32)}`, caveats: [], salt: '1', signature: '0x01' });
const membership = (m: string, over: Record<string, unknown> = {}) => ({ type: 'ap.org.membership.v1', memberAgent: m, organizationAgent: ORG, displayName: 'M', roleAssignment: { materializedByDelegation: wire(m, ORG) }, ...over });
const listing = (m: string, name: string) => ({ label: name, listing: { type: 'ap.home.directory-listing.v1', subject: caip(m), context: { kind: 'org', id: ORG }, displayName: name, publishedAt: '2026-01-01T00:00:00.000Z', proof: { signature: '0x01' } } });

function org(opts: { vault?: Record<string, unknown>; grants?: string[]; vaultFails?: string[] } = {}) {
  const vault: Record<string, unknown> = {
    'directory.data': [listing(BOB, 'Bob'), listing(ERIN, 'Erin'), listing(CAROL, 'Carol')],
    [`org.membership:member:${CAROL}`]: membership(CAROL),
    [`org.membership:member:${BOB}`]: membership(BOB, { endedAt: '2026-10-01T00:00:00.000Z', endReason: 'left' }),
    [`org.membership:member:${FRAN}`]: membership(FRAN),
    ...(opts.vault ?? {}),
  };
  const local = new Map<string, unknown>((opts.grants ?? [CAROL, BOB, DAVE, ERIN]).map((m) => [consultGrantRecordKey(m), { wire: wire(m, ORG), member: m }]));
  const storage = {
    async get(k: string) { return local.get(k); },
    async put(k: string, v: unknown) { local.set(k, v); },
    async delete(k: string) { local.delete(k); },
    async list({ prefix }: { prefix: string }) { return new Map([...local].filter(([k]) => k.startsWith(prefix))); },
  };
  const d = new InteractionsDO({ storage } as unknown as DurableObjectState, { CHAIN_ID: String(CHAIN), DELEGATION_MANAGER: '0x7777777777777777777777777777777777777777', RPC_URL: 'https://rpc.example.test' } as unknown as ConstructorParameters<typeof InteractionsDO>[1]);
  const reads: string[] = [];
  const hooks = d as unknown as Record<string, unknown>;
  hooks.readDoc = async (_g: unknown, resource: string, empty: unknown) => {
    reads.push(resource);
    if (opts.vaultFails?.includes(resource)) throw new Error('vault unavailable');
    return vault[resource] ?? empty;
  };
  hooks.erc1271 = async () => true;                                   // every signature here is genuine
  hooks.pub = () => ({ readContract: async () => false });            // …and nothing is revoked
  const eligible = (channel: unknown = { participationPolicy: 'open' }, only?: string) =>
    (hooks.consultEligible as (g: unknown, p: string, c: unknown, o?: string) => Promise<Array<{ memberSA: string; displayName: string }>>).call(d, {}, ORG, channel, only);
  return { eligible, reads };
}
const who = (rows: Array<{ memberSA: string }>) => rows.map((r) => r.memberSA).sort();

describe('consult eligibility — current member ∩ live grant (DATB-3)', () => {
  it('a departed member with a still-live grant is NOT consulted; nor is a grant holder who was never a member', async () => {
    const { eligible } = org();
    const got = await eligible();
    expect(who(got)).toEqual([CAROL, ERIN].sort());
    expect(who(got)).not.toContain(BOB);
    expect(who(got)).not.toContain(DAVE);
  });

  it('an ENDED membership record outranks a listing that still stands', async () => {
    // Bob's listing is current and "signed"; the organization stamped his membership ended. He is out.
    expect(who(await org({ grants: [BOB] }).eligible())).toEqual([]);
    // The same listing with no record at all is a (pre-382) member.
    expect(who(await org({ grants: [BOB], vault: { [`org.membership:member:${BOB}`]: null } }).eligible())).toEqual([BOB]);
  });

  it('a current member who never opted in is not consulted — membership is not consent either', async () => {
    expect(who(await org().eligible())).not.toContain(FRAN);
  });

  it('membership is read from the organization\'s records, never from the grant store', async () => {
    const { eligible, reads } = org({ grants: [CAROL, DAVE] });
    await eligible();
    expect(reads).toContain(`org.membership:member:${CAROL}`);
    expect(reads).toContain(`org.membership:member:${DAVE}`);
  });

  it('fails closed: a membership record that cannot be read is not a current member', async () => {
    expect(who(await org({ grants: [CAROL], vaultFails: [`org.membership:member:${CAROL}`] }).eligible())).toEqual([]);
  });

  it('a restricted topic consults its participants only, and proves membership only for them', async () => {
    const { eligible, reads } = org();
    const got = await eligible({ participationPolicy: 'restricted', members: [ERIN] });
    expect(who(got)).toEqual([ERIN]);
    expect(reads).not.toContain(`org.membership:member:${CAROL}`);
  });

  it('the send-time re-check answers for one member', async () => {
    expect(who(await org().eligible(null, CAROL))).toEqual([CAROL]);
    expect(who(await org().eligible(null, BOB))).toEqual([]);
    expect(who(await org().eligible(null, FRAN))).toEqual([]);
  });
});

describe('submitConsult — no request exists for a member the eligibility read does not name', () => {
  it('throws ConsultNotEligibleError before anything is signed or sent', async () => {
    let touched = false;
    const env = new Proxy({}, { get: () => { touched = true; return undefined; } }) as never;
    await expect(submitConsult(env, { org: ORG, orgWire: wire(ORG, CAROL) as never, grant: wire(BOB, ORG) as never, memberSA: BOB, eligible: [{ memberSA: CAROL }], question: 'q', topicId: 't', questionId: 'q1' }))
      .rejects.toBeInstanceOf(ConsultNotEligibleError);
    expect(touched).toBe(false);
  });
});
