// Spec 366 R1 — WHICH AGENT ANSWERS A STEP. A tool that declares a `subject` argument is answered by the
// agent it names; the person's own agent routes there instead of reading that agent's records itself.
import { describe, it, expect } from 'vitest';
import { routedSubjectFor } from '../../src/harness-run.js';
import { MEMBERSHIP_LIST_TOOL } from '@agenticprimitives/context';
import type { Address } from '@agenticprimitives/types';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const ORG = '0x00000000000000000000000000000000000000c1' as Address;

describe('routedSubjectFor', () => {
  it('routes a roster question about ANOTHER organization to that organization', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: ORG }, ALICE)).toBe(ORG);
  });
  it('runs locally when the subject IS the agent addressed (the org answering for itself)', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: ORG }, ORG)).toBeNull();
  });
  it('runs locally when no subject was named (the addressee is meant)', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, {}, ALICE)).toBeNull();
  });
  it('never routes on an UNRESOLVED name — resolution is the resolver’s, and a name is not an agent', () => {
    expect(routedSubjectFor(MEMBERSHIP_LIST_TOOL, { org: 'missio nexus' }, ALICE)).toBeNull();
  });
  it('a tool that declares no subject is always answered by the addressee', () => {
    expect(routedSubjectFor({ id: 'x' } as never, { org: ORG }, ALICE)).toBeNull();
  });
});
