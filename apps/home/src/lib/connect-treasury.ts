// Connect-treasury ceremony (spec 283 §connect-treasury + spec 284). Binds a treasury (or any service)
// Smart Agent to its A2A + MCP hosts in three steps, composing EXISTING rails — it reinvents nothing:
//   1. BIND      — set the SA's a2aEndpoint + mcpEndpoint naming records (spec 280 resolver-write rail).
//   2. AUTHORIZE — mint a scoped, monotonic delegation SA → host (caveats from a TreasuryAuthorityScope).
//   3. ASSERT    — publish the SA's skills (spec 282 → atl:skills) so they're discoverable + carded.
// Pure + injectable: all signing / userOp / broadcast happens through the injected deps (the app wires
// signHashFor → executeCall / issueSiteDelegation / setSkills). Generic across service smart agents —
// discovery and treasury are both service SAs; only the scope + skills are treasury-supplied.
import { buildRecordCalls, type ContractCall } from '@agenticprimitives/agent-naming/custody';
import {
  buildCaveat, encodeAllowedTargetsTerms, encodeTimestampTerms, encodeValueTerms,
  type Caveat, type Delegation,
} from '@agenticprimitives/delegation';
import {
  TREASURY_PROFILES, treasuryScopeToCaveatTerms,
  type TreasuryAuthorityScope, type TreasuryProfileId,
} from '@agenticprimitives/treasury-service-agent';
import type { Address, Hex } from 'viem';

export interface ServiceHostEndpoints { a2aEndpoint?: string; mcpEndpoint?: string }

/** STEP 1 (BIND): the naming-record write calls for the SA's a2a/mcp endpoints (spec 280 rail). */
export function buildHostBindCalls(args: { resolver: Address; node: Hex; endpoints: ServiceHostEndpoints }): ContractCall[] {
  return buildRecordCalls({ resolver: args.resolver, node: args.node, records: { a2aEndpoint: args.endpoints.a2aEndpoint, mcpEndpoint: args.endpoints.mcpEndpoint } });
}

/** The on-chain enforcers the ceremony can express a scope through. */
export interface CeremonyEnforcers { timestampEnforcer: Address; valueEnforcer: Address; allowedTargetsEnforcer: Address }

/** STEP 2 (AUTHORIZE): lower a neutral TreasuryAuthorityScope → enforcer caveats. Only the scope kinds with
 *  an on-chain enforcer are mapped; the rest (allowed-skills / allowed-networks / value-total /
 *  allowed-asset-types) stay off-chain policy and are reported in `unmapped` (fail-loud, not silent). The
 *  resulting grant is monotonic — it can only narrow what the scope describes. */
export function scopeToHostCaveats(scope: TreasuryAuthorityScope, enforcers: CeremonyEnforcers): { caveats: Caveat[]; unmapped: string[] } {
  const caveats: Caveat[] = [];
  const unmapped: string[] = [];
  for (const term of treasuryScopeToCaveatTerms(scope)) {
    switch (term.kind) {
      case 'time-window': {
        const w = term.value as { notBefore?: number; notAfter?: number };
        caveats.push(buildCaveat(enforcers.timestampEnforcer, encodeTimestampTerms(w.notBefore ?? 0, w.notAfter ?? 0)));
        break;
      }
      case 'value-per-tx':
        caveats.push(buildCaveat(enforcers.valueEnforcer, encodeValueTerms(BigInt(term.value as string))));
        break;
      case 'allowed-targets':
        caveats.push(buildCaveat(enforcers.allowedTargetsEnforcer, encodeAllowedTargetsTerms(term.value as Address[])));
        break;
      default:
        unmapped.push(term.kind); // no on-chain enforcer yet → host/policy-enforced off chain
    }
  }
  return { caveats, unmapped };
}

const FAMILY_OF = (skillId: string): string => {
  switch (skillId.split('.')[1] ?? '') {
    case 'account': case 'portfolio': return 'treasury.portfolio';
    case 'transfer': case 'transaction': return 'treasury.payments';
    case 'swap': case 'perp': case 'prediction': case 'bridge': return 'treasury.trading';
    case 'lending': case 'staking': case 'liquidity': case 'vault': return 'treasury.yield';
    case 'risk': return 'treasury.risk';
    case 'strategy': return 'treasury.strategy';
    case 'service': case 'network': case 'market-data': return 'treasury.info';
    default: return 'treasury.administration';
  }
};

/** STEP 3 (ASSERT): the PUBLIC capability families to publish for a profile (coarse, public-safe — fine
 *  skills stay on the authenticated card). Private skills + the administration family are never published. */
export function treasurySkillsToPublish(profile: TreasuryProfileId): string[] {
  const fams = new Set(
    TREASURY_PROFILES[profile].definitions.filter((d) => d.defaultExposure !== 'private').map((d) => FAMILY_OF(d.id)),
  );
  fams.delete('treasury.administration');
  return [...fams].sort();
}

export interface ConnectTreasuryArgs {
  resolver: Address;
  node: Hex;
  endpoints: ServiceHostEndpoints;
  scope: TreasuryAuthorityScope;
  enforcers: CeremonyEnforcers;
  profile: TreasuryProfileId;
}

/** Injected effects — the app supplies these (signHashFor → executeCall / issueSiteDelegation / setSkills). */
export interface ConnectTreasuryDeps {
  /** Broadcast the BIND calls as one batched userOp on the treasury SA. */
  executeBatch(calls: ContractCall[]): Promise<{ txHash?: Hex }>;
  /** Sign the scoped host delegation (off-chain) and return it. */
  issueHostDelegation(caveats: Caveat[]): Promise<Delegation>;
  /** Publish the SA's declared capabilities for discovery (spec 282). `publishSkills` is the legacy name. */
  publishSkills(skills: string[]): Promise<{ txHash?: Hex }>;
  onStep?(step: 'bind' | 'authorize' | 'assert'): void;
}

export interface ConnectTreasuryResult {
  bindTxHash?: Hex;
  delegation: Delegation;
  publishTxHash?: Hex;
  publishedSkills: string[];
  unmappedCaveats: string[];
}

/** Orchestrate bind → authorize → assert. Deterministic order; each step delegates the actual signing /
 *  broadcast to the injected deps. */
export async function connectTreasuryCeremony(args: ConnectTreasuryArgs, deps: ConnectTreasuryDeps): Promise<ConnectTreasuryResult> {
  deps.onStep?.('bind');
  const bind = await deps.executeBatch(buildHostBindCalls({ resolver: args.resolver, node: args.node, endpoints: args.endpoints }));

  deps.onStep?.('authorize');
  const { caveats, unmapped } = scopeToHostCaveats(args.scope, args.enforcers);
  const delegation = await deps.issueHostDelegation(caveats);

  deps.onStep?.('assert');
  const publishedSkills = treasurySkillsToPublish(args.profile);
  const publish = await deps.publishSkills(publishedSkills);

  return { bindTxHash: bind.txHash, delegation, publishTxHash: publish.txHash, publishedSkills, unmappedCaveats: unmapped };
}
