// The archetype dispatch grant — direction, scope, and the refusals.
//
// This credential is the only thing standing between "an org hosts archetypes" and "another org can
// spend its agent budget". Two properties carry that: the delegator must be the HOST (so a caller
// cannot authorize itself), and allowedMethods must name one selector PER ARCHETYPE (so a grant for
// the Ontologist is not silently a grant for everything).
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, keccak256, toBytes } from 'viem';
import {
  ARCHETYPE_GRANT_VALIDITY_SECONDS,
  archetypeMethod,
  archetypeMethodSelectors,
  issueArchetypeDispatchDelegation,
  issueOrgConsultRoutingDelegation,
} from './delegation';

const HOST = '0x1111111111111111111111111111111111111111' as const;
const CALLER = '0x2222222222222222222222222222222222222222' as const;
const sign = async () => ('0x' + 'ab'.repeat(65)) as `0x${string}`;

const methodsCaveat = (d: Awaited<ReturnType<typeof issueArchetypeDispatchDelegation>>) => {
  // The allowedMethods caveat is the last of the three the builder appends.
  const c = d.caveats[2]!;
  return decodeAbiParameters([{ type: 'bytes4[]' }], c.terms)[0] as readonly string[];
};

describe('archetypeMethod / selectors', () => {
  it('derives the method the harness answers on', () => {
    expect(archetypeMethod('ontologist')).toBe('archetype.ontologist');
  });

  it('derives the selector demo-a2a will decode against — same keccak, same 4 bytes', () => {
    // If these two derivations ever diverge, a grant authorizes a method nobody calls and the
    // failure is an opaque gate rejection.
    const expected = keccak256(toBytes('archetype.ontologist')).slice(0, 10);
    expect(archetypeMethodSelectors(['ontologist'])[0]).toBe(expected);
  });

  it('one selector per archetype, order preserved', () => {
    expect(archetypeMethodSelectors(['ontologist', 'taxonomist'])).toHaveLength(2);
    expect(archetypeMethodSelectors(['ontologist', 'taxonomist'])[0])
      .not.toBe(archetypeMethodSelectors(['ontologist', 'taxonomist'])[1]);
  });
});

describe('issueArchetypeDispatchDelegation', () => {
  it('is minted BY THE HOST — the delegator hosts the archetypes, the delegate calls', async () => {
    // The opposite direction would let a caller authorize itself; the host's gate would reject it.
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    expect(d.delegator).toBe(HOST);
    expect(d.delegate).toBe(CALLER);
    expect(d.signature).not.toBe('0x');
  });

  it('pins allowedTargets to the host so the grant is not replayable elsewhere', async () => {
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    const targets = decodeAbiParameters([{ type: 'address[]' }], d.caveats[1]!.terms)[0] as readonly string[];
    expect(targets.map((t) => t.toLowerCase())).toEqual([HOST.toLowerCase()]);
  });

  it('names ONE SELECTOR PER ARCHETYPE — withholding a role is the point', async () => {
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist', 'ontology-reviewer'], sign);
    const methods = methodsCaveat(d);
    expect(methods).toHaveLength(2);
    expect(methods).toContain(archetypeMethodSelectors(['ontologist'])[0]);
    expect(methods).toContain(archetypeMethodSelectors(['ontology-reviewer'])[0]);
    // A role NOT granted must be absent — that is what makes a partial grant meaningful.
    expect(methods).not.toContain(archetypeMethodSelectors(['ontology-creation-planner'])[0]);
  });

  it('never carries a wildcard', async () => {
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    for (const m of methodsCaveat(d)) expect(m).not.toBe('0xffffffff');
  });

  it('is timestamp-bounded at 90 days by default', async () => {
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    const [, validUntil] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], d.caveats[0]!.terms);
    const expected = BigInt(Math.floor(Date.now() / 1000) + ARCHETYPE_GRANT_VALIDITY_SECONDS);
    expect(Number(validUntil as bigint)).toBeGreaterThan(Number(expected) - 30);
    expect(Number(validUntil as bigint)).toBeLessThanOrEqual(Number(expected) + 1);
  });

  it('normalizes and de-duplicates slugs', async () => {
    const d = await issueArchetypeDispatchDelegation(HOST, CALLER, ['Ontologist', ' ontologist ', 'taxonomist'], sign);
    expect(methodsCaveat(d)).toHaveLength(2);
  });

  it('REFUSES an empty grant — it would authorize nothing and read as a mystery at the gate', async () => {
    await expect(issueArchetypeDispatchDelegation(HOST, CALLER, [], sign)).rejects.toThrow(/at least one archetype/);
    await expect(issueArchetypeDispatchDelegation(HOST, CALLER, ['  '], sign)).rejects.toThrow(/at least one archetype/);
  });

  it('REFUSES a malformed slug rather than minting a selector for a method nobody serves', async () => {
    await expect(issueArchetypeDispatchDelegation(HOST, CALLER, ['Not A Slug'], sign)).rejects.toThrow(/invalid archetype slug/);
    await expect(issueArchetypeDispatchDelegation(HOST, CALLER, ['../evil'], sign)).rejects.toThrow(/invalid archetype slug/);
  });

  it('REFUSES a self-grant — self-dispatch must not depend on a revocable credential', async () => {
    await expect(issueArchetypeDispatchDelegation(HOST, HOST, ['ontologist'], sign)).rejects.toThrow(/self-dispatch/);
  });

  it('uses a fresh salt per mint, so re-granting does not collide with the old delegation', async () => {
    const a = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    const b = await issueArchetypeDispatchDelegation(HOST, CALLER, ['ontologist'], sign);
    expect(a.salt).not.toBe(b.salt);
  });
});

// THE ORG SIGNING WIRE — the second credential, and the one that was missed.
//
// The dispatch GRANT says a caller may invoke a method. This wire says the org can SIGN AS ITSELF
// for that method. A caller holding a perfect grant still cannot dispatch if its own wire names only
// discussion.consult: the host's gate verifies the session-wrapped signature against the wire and
// finds the method absent. Grants without this are a credential that verifies nowhere.
describe('issueOrgConsultRoutingDelegation — archetype methods', () => {
  const ORG = '0x3333333333333333333333333333333333333333' as const;
  const KEY = '0x4444444444444444444444444444444444444444' as const;
  const methods = async (archetypes?: string[]) => {
    const d = await issueOrgConsultRoutingDelegation(ORG, KEY, sign, undefined, archetypes);
    const amCav = d.caveats[2]!;
    return (decodeAbiParameters([{ type: 'bytes4[]' }], amCav.terms)[0] as readonly string[]).map((x) => x.toLowerCase());
  };

  it('still names consult when no archetypes are given — the existing rail is unchanged', async () => {
    const m = await methods();
    expect(m).toHaveLength(1);
    expect(m[0]).toBe(keccak256(toBytes('discussion.consult')).slice(0, 10).toLowerCase());
  });

  it('adds the archetype methods ALONGSIDE consult, in one wire', async () => {
    const m = await methods(['ontologist', 'taxonomist']);
    expect(m).toHaveLength(3);
    expect(m).toContain(keccak256(toBytes('discussion.consult')).slice(0, 10).toLowerCase());
    expect(m).toContain(archetypeMethodSelectors(['ontologist'])[0]!.toLowerCase());
    expect(m).toContain(archetypeMethodSelectors(['taxonomist'])[0]!.toLowerCase());
  });

  it('never carries the any-skill sentinel — every method is named', async () => {
    for (const x of await methods(['ontologist'])) expect(x).not.toBe('0xffffffff');
  });

  it('normalizes, de-duplicates and drops malformed slugs rather than minting junk selectors', async () => {
    const m = await methods(['Ontologist', ' ontologist ', 'Not A Slug', '../evil', '']);
    expect(m).toHaveLength(2);           // consult + ontologist once
  });
});
