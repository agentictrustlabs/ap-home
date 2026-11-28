import { describe, expect, it } from 'vitest';
import { relationshipRows } from '@agenticprimitives/context';
import { MAX_WIRES, mergeRelationshipWires } from '../src/relationship-wires.js';

const HH = '0xd79ddee7eaf359bbd1145af580f8082cd0fe36a0';
const BOB = '0xab8bcf0e1d51d34ef2f83e63984d94070f40fad6';
const wire = (sig: string, from = HH, to = BOB) => ({ delegator: from, delegate: to, signature: sig, caveats: [] });
const memberGrant = wire('0xmember');
const consent = wire('0xconsent', BOB, HH);
const stewardGrant = wire('0xsteward');

describe('the wires on a person’s link: the steward grant leads', () => {
  it('a member made a steward reads with the STEWARD grant first (the demo household’s second steward)', () => {
    // what Bob's link held: the member grant first, then consents and a repeat, then the steward grant appended last
    const prev = [memberGrant, consent, memberGrant, consent];
    const out = mergeRelationshipWires({ prev, incoming: [stewardGrant], entryRelationship: 'steward', resultRelationship: 'steward' })!;
    expect(out[0]).toBe(stewardGrant);
    expect(out).toHaveLength(3); // the repeats are kept once
    // and the one reader every standing check uses now takes the steward grant
    const rows = relationshipRows({ orgs: { [HH]: { org: HH, relationship: 'steward', delegations: out } } });
    expect(rows[0]!.stewardshipDelegation).toBe(stewardGrant);
  });

  it('accepting twice moves the same grant to the front once', () => {
    const once = mergeRelationshipWires({ prev: [memberGrant, stewardGrant], incoming: [stewardGrant], entryRelationship: 'steward', resultRelationship: 'steward' })!;
    expect(once).toEqual([stewardGrant, memberGrant]);
  });

  it('a member merge after stewardship appends and never displaces the leading steward grant', () => {
    const prev = [stewardGrant, ...Array.from({ length: MAX_WIRES - 1 }, (_, i) => wire(`0xold${i}`))];
    const out = mergeRelationshipWires({ prev, incoming: [wire('0xnew')], entryRelationship: 'member', resultRelationship: 'steward' })!;
    expect(out).toHaveLength(MAX_WIRES);
    expect(out[0]).toBe(stewardGrant);
    expect(out.at(-1)).toEqual(wire('0xnew'));
  });

  it('a plain member link still keeps the latest wires', () => {
    const prev = Array.from({ length: MAX_WIRES }, (_, i) => wire(`0xm${i}`));
    const out = mergeRelationshipWires({ prev, incoming: [wire('0xlast')], entryRelationship: 'member', resultRelationship: 'member' })!;
    expect(out).toHaveLength(MAX_WIRES);
    expect(out[0]).toEqual(wire('0xm1'));
  });

  it('no wires on either side stays no wires', () => {
    expect(mergeRelationshipWires({ prev: undefined, incoming: undefined, entryRelationship: 'member', resultRelationship: 'member' })).toBeUndefined();
  });
});
