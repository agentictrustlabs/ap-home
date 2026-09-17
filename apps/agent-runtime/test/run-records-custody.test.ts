/**
 * WHO MAY LOOK BACK ON A RUN — the two claims, and why one alone was not enough.
 *
 * `/harness/records` tested one thing: did YOU ask this run. That keeps one asker's runs from another's, and
 * it silently erased the history of every agent whose work is asked by somebody else. A persona cast in a
 * Mystery Night is exactly that — the card room asks it AS THE HOUSE — so its custodian opened Activities on
 * an agent in the middle of a game and saw nothing at all, while the records sat in the store under its
 * address the whole time.
 *
 * The custodian's claim is not the asker's: it is her agent, her tokens were spent thinking, and she is
 * answerable for what it did. So the gate admits the asker OR whoever holds the agent — proved, as everywhere
 * else here, from the CALLER's own links rather than the addressee's say-so.
 */
import { describe, it, expect } from 'vitest';
import { relationshipRows } from '@agenticprimitives/context';

const HOUSE = '0x0347e808a0bb7a7a7086a29d853e799f35104dd0';
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const PERRIN = '0x3ff4918575af25ff789d216c42183f2161e8fef3';

/** The listing's rule, as the route applies it. */
const visible = (
  records: ReadonlyArray<{ intent?: { context?: { asker?: string } } }>,
  caller: string,
  holds: boolean,
) => (holds ? records : records.filter((r) => String(r.intent?.context?.asker ?? '').toLowerCase() === caller.toLowerCase()));

const RUNS = [
  { intent: { context: { asker: HOUSE } } }, // a night asked it to act
  { intent: { context: { asker: HOUSE } } },
  { intent: { context: { asker: ALICE } } }, // and once she asked it herself
];

describe('looking back on a persona’s runs', () => {
  it('a custodian sees every run of an agent she holds, whoever asked it', () => {
    expect(visible(RUNS, ALICE, true)).toHaveLength(3);
  });

  it('WITHOUT the custody claim she sees only her own — the bug: an agent mid-game, Activities empty', () => {
    expect(visible(RUNS, ALICE, false)).toHaveLength(1);
    // And an agent that has only ever answered other people disappears entirely.
    expect(visible(RUNS.slice(0, 2), ALICE, false)).toHaveLength(0);
  });

  it('a stranger who neither asked nor holds it sees nothing', () => {
    const stranger = '0x9999999999999999999999999999999999999999';
    expect(visible(RUNS, stranger, false)).toHaveLength(0);
  });

  it('a persona’s `self` link carries steward-strength custody, which is what the gate reads', () => {
    // The custodian's own relationships doc, as `/connect/related-orgs` writes it for a persona.
    const doc = { orgs: { [PERRIN]: { org: PERRIN, relationship: 'self', kind: 'person', updatedAt: '2026-09-17T00:00:00Z' } } };
    const row = relationshipRows(doc).find((r) => r.agent === PERRIN);
    expect(row?.relationship).toBe('steward');
    expect(row?.recorded).toBe('self');
  });
});
