// Spec 445 §3.1 (audit AUTH-3 / H-7) — WHOSE AUTHORITY A STEP NEEDS is one rule (`authorityPartyFor`), read by the
// reply that names who is asked to sign AND by the mandate verifier, which requires the presented chain's root
// delegator to be that party. Before this, a mandate signed by ANY account was judged on its own caveats alone.
import { describe, it, expect } from 'vitest';
import { ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import type { Address } from '@agenticprimitives/types';
import { authorityPartyFor, runUnderMandate, type HarnessDeps, type HarnessEnv } from '../src/harness-run.js';

const PERSON = '0x00000000000000000000000000000000000000aa' as Address;
const ORG = '0x00000000000000000000000000000000000000bb' as Address;
const ALICE = '0x00000000000000000000000000000000000000cc' as Address;
const ATTACKER = '0x00000000000000000000000000000000000000ee' as Address;
const HARNESS = '0x00000000000000000000000000000000000000dd' as Address;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe('authorityPartyFor — the one rule for whose authority a step needs', () => {
  it('the declared authority, when its argument is set', async () => {
    expect(await authorityPartyFor({ id: 'treasury.payment.execute', authority: ORG.toUpperCase().replace('0X', '0x'), resource: addr(0x5d) }, PERSON)).toBe(ORG);
  });
  it('a capability that DECLARES an authority never falls through to the thing it acts on', async () => {
    // messaging declares `authorityArg: 'sender'`; with no sender set, the party is the agent asked — never the recipient.
    expect(await authorityPartyFor({ id: 'messaging.direct.send', resource: ALICE }, PERSON)).toBe(PERSON);
  });
  it('a capability that declares none: the resource IS the party (the parent a team is chartered under)', async () => {
    expect(await authorityPartyFor({ id: 'organization.team.create', resource: ORG }, PERSON)).toBe(ORG);
  });
  it('a name is read once from the naming records; a name nothing holds falls to the agent asked', async () => {
    const names = async (n: string) => (n === 'missio.org' ? ORG : null);
    expect(await authorityPartyFor({ id: 'treasury.payment.execute', authority: 'Missio.org' }, PERSON, names)).toBe(ORG);
    expect(await authorityPartyFor({ id: 'treasury.payment.execute', authority: 'nobody.org' }, PERSON, names)).toBe(PERSON);
  });
  it('nobody named at all is null — the verifier then denies', async () => {
    expect(await authorityPartyFor({ id: 'messaging.direct.send' }, undefined)).toBeNull();
    expect(await authorityPartyFor({ id: 'messaging.direct.send', authority: 'not-an-address' }, undefined)).toBeNull();
  });
});

describe('the run refuses a mandate whose root is not the party the step needs', () => {
  const env = {
    CHAIN_ID: '34348', DELEGATION_MANAGER: addr(0xd00), UNIVERSAL_SIGNATURE_VALIDATOR: addr(0xd01), HARNESS_AGENT_SA: HARNESS,
    DIGEST_BINDING_ENFORCER: addr(0xe01), TIMESTAMP_ENFORCER: addr(0xe02), ALLOWED_TARGETS_ENFORCER: addr(0xe03),
    ALLOWED_METHODS_ENFORCER: addr(0xe04), VALUE_ENFORCER: addr(0xe05), PAYMENT_ENFORCER: addr(0xe06),
  } as unknown as HarnessEnv;
  const sent: unknown[] = [];
  const deps = {
    audit: { write: async () => undefined },
    // Every on-chain read says "fine": signature valid, not revoked. Only the root-is-the-principal rule can refuse.
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'isRevoked' ? false : true),
    sendDirectMessage: async (m: unknown) => { sent.push(m); return { ok: true, messageId: 'm1' }; },
  } as unknown as HarnessDeps;
  const run = (delegator: Address) => runUnderMandate(env, deps, {
    intent: { goal: 'send alice a message: hello' },
    plan: { steps: [{ toolId: 'messaging.direct.send', args: { recipient: ALICE, sender: PERSON, message: 'hello' } }] },
    presented: { delegator, delegate: HARNESS, authority: ROOT_AUTHORITY, caveats: [], salt: '7', signature: `0x${'11'.repeat(65)}` } as unknown as Delegation,
    person: PERSON, session: 'session', addressee: PERSON,
    mcpInvoke: async () => { throw new Error('not wired'); },
  } as never);

  it('a mandate somebody else signed is denied chain-root-not-principal, and nothing is sent', async () => {
    const { result } = await run(ATTACKER);
    expect(result.outcome).toBe('denied');
    expect(result.error).toMatch(/chain-root-not-principal/);
    expect(sent).toHaveLength(0);
  });

  it('the twin — the same wire from the person herself gets past that rule (and is judged on its own scope)', async () => {
    const { result } = await run(PERSON);
    // It is refused for what it IS (an unbounded wire), which is the next question the verifier asks — proof the
    // root rule is what refused the other one, and not some earlier check both would have met.
    expect(result.outcome).toBe('denied');
    expect(String(result.error ?? '')).toMatch(/carries no caveats/);
    expect(String(result.error ?? '')).not.toMatch(/chain-root-not-principal/);
  });
});
