// Spec 400 W2a — the Worker's half of the open mandate, with no network: `presentedOf` admits only a well-shaped chain
// from an agent caller's continuation (shape here; verification where it is used); `rootDelegatorOf` walks the chain to
// the agent the act is an act OF, so a session-less send is sent as the AGENT only when the chain is rooted at it.
import { describe, it, expect } from 'vitest';
import { hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { presentedOf } from '../src/standard-a2a.js';
import { rootDelegatorOf } from '../src/harness-run.js';

const DM = '0x0000000000000000000000000000000000000d00' as const;
const CHAIN = 34348;
const ME = '0x00000000000000000000000000000000000000aa' as const;
const KEY = '0x00000000000000000000000000000000000000ee' as const;
const HARNESS = '0x00000000000000000000000000000000000000dd' as const;

describe('the open mandate — Worker half', () => {
  it('presentedOf admits a chain of wires and nothing else', () => {
    const wire = { delegator: ME, delegate: KEY, authority: ROOT_AUTHORITY, caveats: [], salt: '1', signature: '0x' };
    expect(presentedOf({ presented: [wire] })).toHaveLength(1);
    expect(presentedOf({ presented: [{ ...wire, caveats: 'nope' }] })).toBeNull();
    expect(presentedOf({ presented: [] })).toBeNull();
    expect(presentedOf({ presented: 'wire' })).toBeNull();
    expect(presentedOf({ presented: Array(6).fill(wire) })).toBeNull();
    expect(presentedOf(undefined)).toBeNull();
  });

  it('rootDelegatorOf walks child → standing → root; a root mandate is its own; a broken chain stops at the leaf', () => {
    const standing: Delegation = { delegator: ME, delegate: KEY, authority: ROOT_AUTHORITY, caveats: [], salt: 1n, signature: '0x' };
    const child: Delegation = { delegator: KEY, delegate: HARNESS, authority: hashDelegation(standing, CHAIN, DM), caveats: [], salt: 2n, signature: '0x' };
    const chain = { chainId: CHAIN, delegationManager: DM };
    expect(rootDelegatorOf({ ref: 'c', wire: child } as never, { ...chain, presentedAll: [{ ref: 'c', wire: child }, { ref: 's', wire: standing }] as never }).toLowerCase()).toBe(ME);
    expect(rootDelegatorOf({ ref: 's', wire: standing } as never, { ...chain, presentedAll: [{ ref: 's', wire: standing }] as never }).toLowerCase()).toBe(ME);
    // the parent not presented: the leaf's own delegator (the key) — never the agent; the verifier refused it anyway
    expect(rootDelegatorOf({ ref: 'c', wire: child } as never, { ...chain, presentedAll: [{ ref: 'c', wire: child }] as never }).toLowerCase()).toBe(KEY);
  });
});
