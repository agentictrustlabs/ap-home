/**
 * `stewardWireFor` — the wire decides, not the relationship word.
 *
 * WHAT THESE PIN, and why the second one is the load-bearing case:
 *
 * The lookup used to require `relationship !== 'member'` in addition to the wire. That was not a
 * check — `relationship` is a display label on a KV projection, while the delegation is re-verified
 * in full by the org's DO downstream (org-signed, unrevoked, stewardship caveat shape). Worse, it was
 * a ONE-WAY DOOR: `/connect/related-orgs` makes the word sticky (`member` can never go back to
 * `steward`), so a link demoted to member could not regain library access even after a valid
 * stewardship wire was re-issued to it. Withdrawing stewardship has to be reversible by re-granting.
 *
 * Withdrawal still works, and works the way it should: remove the WIRE (an explicit
 * `stewardshipDelegation: null` on the link), not the label.
 */
import { describe, it, expect } from 'vitest';

import { stewardWireFor } from './channels';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28';
const ORG = '0xe26157068af46629691e2ab19726bf61476e6b6c';
const WIRE = { delegator: ORG, delegate: PERSON, caveats: [] };

/** Only `AUTH_CODES.get` is reached on the KV path; `bearer` is omitted so no reconcile is attempted. */
const envWith = (link: unknown) =>
  ({
    AUTH_CODES: {
      async get(k: string) {
        return k === `related:${PERSON}:${ORG}` && link ? JSON.stringify(link) : null;
      },
      async put() {},
    },
  }) as never;

describe('stewardWireFor', () => {
  it('returns the wire for a steward link', async () => {
    const env = envWith({ relationship: 'steward', stewardshipDelegation: WIRE });
    expect(await stewardWireFor(env, PERSON, ORG)).toEqual(WIRE);
  });

  /*
    THE REGRESSION THIS FILE EXISTS FOR. A link whose word says `member` while it still holds a live
    stewardship wire is the state a demote-then-restore leaves behind, because the word cannot travel
    back. It must resolve on the wire.
  */
  it('returns the wire even when the relationship word says member', async () => {
    const env = envWith({ relationship: 'member', stewardshipDelegation: WIRE });
    expect(await stewardWireFor(env, PERSON, ORG)).toEqual(WIRE);
  });

  it('returns null when the wire is gone — withdrawal is removing the grant, not relabelling it', async () => {
    const env = envWith({ relationship: 'member', stewardshipDelegation: null });
    expect(await stewardWireFor(env, PERSON, ORG)).toBeNull();
  });

  it('returns null when there is no link at all', async () => {
    expect(await stewardWireFor(envWith(null), PERSON, ORG)).toBeNull();
  });

  it('does not reconcile without a bearer — a KV miss stays a miss', async () => {
    const env = envWith({ relationship: 'steward' });
    expect(await stewardWireFor(env, PERSON, ORG)).toBeNull();
  });
});
