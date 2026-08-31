/**
 * The self-grant store's guards.
 *
 * This endpoint holds a delegation on a person's behalf and hands it back on request, so what it
 * REFUSES is the whole security story. The load-bearing case is the third one: demo-mcp treats a
 * delegation with NO vault-record-scope caveat as inert, which means whole-vault. So an unscoped grant
 * is not "a grant with a missing field" — it is the widest possible grant, and accepting it here would
 * turn a card-editor convenience into a store for full-vault self-delegations.
 */
import { describe, it, expect } from 'vitest';
import { buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms } from '@agenticprimitives/delegation';
import { CONTRACTS } from '../../src/lib/chain';
import { PURPOSE_RESOURCES, validUntilOf, withinPurpose } from './self-grant';
import type { IncomingDelegation } from '../_lib/verify-delegation';

const PERSON = '0x3d653cbab0c99b1513439758eb2eac2039caa6e1';
const ALLOWED = PURPOSE_RESOURCES['agent-card-studio']!;
const future = Math.floor(Date.now() / 1000) + 3600;

const grantWith = (caveats: unknown[]): IncomingDelegation =>
  ({ delegator: PERSON, delegate: PERSON, authority: `0x${'00'.repeat(32)}`, caveats, salt: '1', signature: '0x' }) as never;

const scoped = (resources: string[], ops: ('read' | 'write')[] = ['read', 'write']) =>
  buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources, ops }]);

describe('what the self-grant store accepts', () => {
  it('accepts a grant scoped to exactly the purpose’s record families', () => {
    expect(withinPurpose(grantWith([scoped([...ALLOWED])]), ALLOWED)).toBe(true);
  });

  it('accepts a NARROWER grant — asking for less is always allowed', () => {
    expect(withinPurpose(grantWith([scoped(['vault:agent-cards:*'])]), ALLOWED)).toBe(true);
  });

  it('REFUSES an unscoped grant, because unscoped means the whole vault', () => {
    // No VAULT_RECORD_SCOPE caveat at all: demo-mcp reads that as inert, i.e. every record.
    expect(withinPurpose(grantWith([buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, future))]), ALLOWED)).toBe(false);
  });

  it('REFUSES a grant reaching outside the purpose, even alongside allowed families', () => {
    expect(withinPurpose(grantWith([scoped(['vault:agent-cards:*', 'vault:pii'])]), ALLOWED)).toBe(false);
  });

  it('REFUSES a grant whose scope names no resources', () => {
    expect(withinPurpose(grantWith([{ enforcer: CONTRACTS.timestampEnforcer, terms: '0x', args: '0x' }]), ALLOWED)).toBe(false);
  });
});

describe('expiry comes from the grant, not from the caller', () => {
  it('reads validUntil out of the timestamp caveat', () => {
    const g = grantWith([buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, future)), scoped([...ALLOWED])]);
    expect(validUntilOf(g)).toBe(future);
  });

  it('reports 0 — never "valid" — for a grant carrying no timestamp caveat', () => {
    expect(validUntilOf(grantWith([scoped([...ALLOWED])]))).toBe(0);
  });
});
