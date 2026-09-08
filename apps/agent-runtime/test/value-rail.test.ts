// THE VALUE RAIL — spec 373. Money moves between treasuries, and the check that says so runs where
// nothing can go around it: at the moment of acting, on the on-chain agent type.
//
// The incident this pins: every gate passed and a payment landed on `carol.me`. The resolver had grounds
// to return her (she is in the asker's household), the role admitted a person, and the invoker never asked
// what KIND of agent the payee was. Any one of those changing back must fail here.
import { describe, expect, it } from 'vitest';
import { PARTY_ROLES, VALUE_HOLDING_CLASSES, holdsValue, AGENT_CLASS } from '@agenticprimitives/ontology';
import { harnessInvoker, type HarnessDeps, type HarnessEnv } from '../src/harness-run.js';

const TREASURY = '0x5ef5360a41f31e55541117a854455c0da0fb67b3';
const PERSON = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const ORG = '0x1dba4a27c53d7babda99513080223fb3bfc4bad1';
const UNKNOWN = '0x00000000000000000000000000000000000000ff';
const ASSET = '0xdae09066a2cc32f6203605619137dcf01a9b49ae';

const TYPES: Record<string, string | null> = {
  [TREASURY]: 'treasury', [PERSON]: 'person', [ORG]: 'org', [UNKNOWN]: null,
};
const NAMES: Record<string, string> = {
  [TREASURY]: 'alice2.treasury', [PERSON]: 'carol.me', [ORG]: 'missio-nexus.org',
};

const deps = (over: Partial<HarnessDeps> = {}): HarnessDeps => ({
  readContract: async () => 0n,
  nameOf: async (a: string) => NAMES[a.toLowerCase()] ?? null,
  agentTypeOf: async (a: string) => TYPES[a.toLowerCase()] ?? null,
  ...over,
} as HarnessDeps);

const env = {
  CHAIN_ID: '34348', DELEGATION_MANAGER: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7',
  PAYMENT_ENFORCER: '0x1111111111111111111111111111111111111111',
  TIMESTAMP_ENFORCER: '0x2222222222222222222222222222222222222222',
  DIGEST_BINDING_ENFORCER: '0x3333333333333333333333333333333333333333',
  HARNESS_AGENT_SA: '0xD34c3Fbc89706dd57d426546DCEBD3bA926eDE35',
} as unknown as HarnessEnv;

/** A presented mandate whose delegator is the payer — the shape the invoker reads. */
const presented = (payer: string) => ({
  ref: '0xref', wire: { delegator: payer, delegate: env.HARNESS_AGENT_SA, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: 0n, signature: '0xsig' },
}) as never;

const pay = (payee: string, payer = TREASURY, d = deps()) =>
  harnessInvoker(d, env, presented(payer), async () => ({ never: true }))(
    'treasury.payment.execute',
    { payer, payee, asset: ASSET, usdc: '1' },
    { step: { id: 's0', toolId: 'treasury.payment.execute', args: {} }, index: 0, intent: { goal: 'pay' } } as never,
  );

describe('the ontology says it once', () => {
  it('every role that moves value admits only classes that can hold it', () => {
    for (const role of PARTY_ROLES.filter((r) => r.movesValue)) {
      for (const cls of role.requires) {
        expect(holdsValue(cls), `${role.capability}:${role.arg} admits ${cls}`).toBe(true);
      }
    }
    expect(VALUE_HOLDING_CLASSES).toEqual([AGENT_CLASS.Treasury]);
  });

  it('a person is not an end of a transfer, and neither is an organization', () => {
    expect(holdsValue(AGENT_CLASS.PersonAgent)).toBe(false);
    expect(holdsValue(AGENT_CLASS.OrganizationAgent)).toBe(false);
  });
});

describe('the rail refuses at the act, whatever the plan says', () => {
  it('REFUSES a person as payee — the incident, named in the refusal', async () => {
    await expect(pay(PERSON)).rejects.toThrow(/carol\.me is a person.*money moves between treasuries/i);
  });

  it('REFUSES an organization as payee, and says to name the treasury it charters', async () => {
    await expect(pay(ORG)).rejects.toThrow(/organization.*name the treasury it charters/i);
  });

  it('REFUSES an agent with no type recorded on chain — unreadable is not permission', async () => {
    await expect(pay(UNKNOWN)).rejects.toThrow(/no agent type recorded on chain/i);
  });

  it('REFUSES when the deployment cannot read types at all — a rail that fails open is not a rail', async () => {
    await expect(pay(TREASURY, TREASURY, deps({ agentTypeOf: undefined }))).rejects.toThrow(/cannot read what kind of account/i);
  });

  it('REFUSES a person as PAYER too — both ends are accounts', async () => {
    await expect(pay(TREASURY, PERSON)).rejects.toThrow(/carol\.me is a person/i);
  });

  it('lets treasury → treasury through the rail (it fails later, on the chain reads this test does not stub)', async () => {
    // Reaching a failure that is NOT the rail's is the assertion: the rail said yes and the act went on.
    await expect(pay(TREASURY, TREASURY)).rejects.not.toThrow(/money moves between treasuries|agent type recorded/i);
  });
});
