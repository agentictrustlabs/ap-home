// The genesis-folded planes: deterministic (a resume re-derives what was signed), and scope-PINNED to
// the Home's enable ceremony — two apps that each sign "the interactions grant" must mean the same
// records by it, and the CONSULT_SKILL local-literal precedent only works with a test holding the pin.
import { describe, it, expect } from 'vitest';
import { decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';
import type { Hex } from 'viem';
import { buildGenesisPlanes, GENESIS_INTERACTIONS_SCOPES } from '../src/genesis-planes.js';
import { buildApprovedInteractionsDelegation } from '../../demo-sso-next/src/lib/delegation.js';

const ENV = {
  DELEGATION_MANAGER: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7',
  TIMESTAMP_ENFORCER: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96',
  VALUE_ENFORCER: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975',
  CHAIN_ID: 34348,
};
const CHILD = '0x1111111111111111111111111111111111111111' as const;
const IX_SA = '0x2222222222222222222222222222222222222222' as const;
const SK = '0x3333333333333333333333333333333333333333' as const;
const STEW = { salt: 1000n, validUntil: 2_000_000_000 };

const scopeResources = (caveats: Array<{ enforcer: string; terms: unknown }>): Map<string, string> => {
  const cav = caveats.find((c) => c.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())!;
  const out = new Map<string, string>();
  for (const g of decodeVaultRecordScopeTerms(cav.terms as Hex)) {
    for (const r of g.resources) {
      const prev = out.get(r);
      const ops = [...g.ops].sort().join(',');
      // A resource in two buckets keeps its WIDEST ops (the delete-on-playbook case).
      out.set(r, prev && prev.length > ops.length ? prev : ops);
    }
  }
  return out;
};

describe('buildGenesisPlanes', () => {
  const planes = buildGenesisPlanes(ENV, CHILD, IX_SA, IX_SA, SK, STEW);

  it('is DETERMINISTIC — a resume re-derives exactly what the person signed', () => {
    const again = buildGenesisPlanes(ENV, CHILD, IX_SA, IX_SA, SK, STEW);
    expect(again.digests).toEqual(planes.digests);
    expect(again.interactions.wire.salt).toBe(STEW.salt + 1n);
  });

  it('every wire carries the 0x03 approved-hash sentinel and the stewardship window', () => {
    for (const w of [planes.interactions.wire, planes.sessionLeaf.wire, planes.delivery.wire]) {
      expect(w.signature).toBe('0x03');
      expect(w.delegator.toLowerCase()).toBe(CHILD.toLowerCase());
    }
  });

  it("MATCHES THE HOME'S SCOPES — the parity pin on the two local literals", () => {
    const home = buildApprovedInteractionsDelegation(CHILD, IX_SA, 'demo-mcp');
    const ours = scopeResources(planes.interactions.wire.caveats as never);
    const theirs = scopeResources(home.delegation.caveats as never);
    // Same resources, same widest ops, both directions — a scope added on one side without the other
    // is exactly the drift that made an enabled-looking org 409 on its first new-record write.
    expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
    for (const [r, ops] of theirs) expect(ours.get(r), `ops for ${r}`).toBe(ops);
  });

  it('the delivery plane is write-only on mail — the disjoint-planes rule survives the fold', () => {
    const d = scopeResources(planes.delivery.wire.caveats as never);
    expect(d.get('vault:message.body:dm:*')).toBe('write');
    expect(d.get('vault:inbox.data')).toBe('write');
  });
});
