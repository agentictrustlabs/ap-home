// The governor → workspace OPERATING grant (spec 344 §2.1, Rich/Paul 2026-10-28): what the delegation itself carries.
import { describe, expect, it } from 'vitest';
import { decodeVaultRecordScopeTerms, decodeTimestampTerms, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';
import { buildApprovedWorkspaceOperatingDelegation, APPROVED_HASH_SENTINEL, WORKSPACE_OPERATING_VALIDITY_SECONDS } from './delegation';
import { workspaceOperatingScope } from './workspace-governor';
import { CONTRACTS } from './chain';

const GOV = '0x1111111111111111111111111111111111111111' as const;
const WS = '0x5555555555555555555555555555555555555555' as const;

describe('the governor → workspace operating grant', () => {
  it('runs from the governor to the workspace, scoped to exactly the scope it was given, value 0, a year at most', () => {
    const scope = workspaceOperatingScope(WS, 'demo-mcp');
    const { delegation: d, digest } = buildApprovedWorkspaceOperatingDelegation(GOV, WS, scope);
    expect(d.delegator).toBe(GOV);
    expect(d.delegate).toBe(WS);
    expect(d.signature).toBe(APPROVED_HASH_SENTINEL);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    const enforcers = d.caveats.map((c) => c.enforcer.toLowerCase());
    expect(enforcers).toEqual([CONTRACTS.timestampEnforcer, CONTRACTS.valueEnforcer, VAULT_RECORD_SCOPE_ENFORCER].map((e) => e.toLowerCase()));
    // No allowed-targets / methods: it redeems no on-chain call — record operations only.
    expect(enforcers).not.toContain(CONTRACTS.allowedTargetsEnforcer.toLowerCase());
    const scopeCaveat = d.caveats.find((c) => c.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())!;
    expect(decodeVaultRecordScopeTerms(scopeCaveat.terms)).toEqual(scope);
    const w = decodeTimestampTerms(d.caveats[0]!.terms);
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(w.validUntil - now <= BigInt(WORKSPACE_OPERATING_VALIDITY_SECONDS)).toBe(true);
    expect(w.validUntil > now).toBe(true);
  });

  it('refuses to be built without a scope — never an unscoped grant', () => {
    expect(() => buildApprovedWorkspaceOperatingDelegation(GOV, WS, [])).toThrow(/names its scope/);
  });
});
