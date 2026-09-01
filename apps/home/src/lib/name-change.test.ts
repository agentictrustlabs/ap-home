/**
 * The rename rules, against what the contracts actually permit.
 *
 * `PermissionlessSubregistry.claimedBy` is write-once and has no release (see the contract: `register`
 * reverts `AlreadyClaimed`, and nothing clears the mapping). So an agent cannot take a second label
 * under a root it has used — and `claimName` turns that attempt into a SILENT no-op that returns the
 * old name. A rename screen that offers such a suffix produces a submit button that cannot work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimableSuffix, isPresented, clearingLeavesNoName, type HeldRoot } from './name-change';

const node = (n: string) => (`0x${n.repeat(64).slice(0, 64)}`) as `0x${string}`;
const held = (tld: string, typed = true, n = '1'): HeldRoot => ({ tld, node: node(n), name: `x.${tld}`, typed });

describe('claimableSuffix', () => {
  it('offers the type’s suffix when the agent has not used it', () => {
    expect(claimableSuffix({ tld: 'org' }, [held('impact', false)])).toEqual({ tld: 'org' });
  });

  it('offers nothing once that suffix is used — a second label there reverts', () => {
    expect(claimableSuffix({ tld: 'org' }, [held('impact', false), held('org')])).toBeNull();
  });

  it('offers nothing when the deployment has no typed suffix for the kind', () => {
    expect(claimableSuffix(undefined, [])).toBeNull();
  });

  it('never offers a suffix belonging to a different type, even when free', () => {
    // A person holding only `.impact` must not be offered `.org` because it happens to be unclaimed:
    // the suffix states the on-chain agent type, and a mismatch fails closed at the registry.
    const forPerson = { tld: 'me' };
    expect(claimableSuffix(forPerson, [held('impact', false)])).toEqual(forPerson);
    expect(claimableSuffix(forPerson, [held('me')])).toBeNull();
  });

  it('carries the serviceRole through, since a typed service claim needs it', () => {
    expect(claimableSuffix({ tld: 'workspace', serviceRole: 'workspace' }, []))
      .toEqual({ tld: 'workspace', serviceRole: 'workspace' });
  });
});

describe('isPresented', () => {
  it('compares node hex case-insensitively', () => {
    const lower = '0xabcdef'.padEnd(66, '0') as `0x${string}`;
    const upper = '0xABCDEF'.padEnd(66, '0') as `0x${string}`;
    expect(isPresented(lower, upper)).toBe(true);
  });

  it('is false when the agent presents no name', () => {
    expect(isPresented(node('1'), null)).toBe(false);
  });
});

describe('clearingLeavesNoName', () => {
  it('is true when the agent holds only the one', () => {
    expect(clearingLeavesNoName([held('me')])).toBe(true);
    expect(clearingLeavesNoName([])).toBe(true);
  });

  it('is false when another held name could be presented instead', () => {
    expect(clearingLeavesNoName([held('impact', false), held('me', true, '2')])).toBe(false);
  });
});

describe('the claim path cannot report a no-op as a rename', () => {
  const SRC = readFileSync(join(__dirname, '..', 'connect-client.ts'), 'utf8');

  it('claimName flags an already-claimed root instead of returning a bare success', () => {
    expect(SRC).toContain('alreadyClaimed?: boolean');
  });

  it('and re-points the primary name rather than doing nothing', () => {
    // Clearing the public name leaves the claim intact and the pointer empty. Without this, "claim your
    // name" on a cleared agent reported the old name and changed nothing on chain.
    expect(SRC).toContain("functionName: 'primaryName'");
    expect(SRC).toContain('could not present the held name');
    expect(SRC).toContain('alreadyClaimed: !restored');
  });

  it('clearing sends the zero node, which is what the registry treats as "no name"', () => {
    expect(SRC).toMatch(/node: node \?\? \(`0x\$\{'0'\.repeat\(64\)\}` as Hex\)/);
  });
});
