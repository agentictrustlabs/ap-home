// Base Sepolia (chain 84532) config for the REAL Connect directory (spec 227).
// R7.3: addresses come from the @agenticprimitives/contracts package's
// generated deployments module so a contracts redeploy auto-propagates here
// without any per-app sync (this used to require touching three chain.ts
// files in lockstep — see 2026-06-01 deploy session for the bug class).

import type { Address } from '@agenticprimitives/types';
import { CONTRACTS as DEPLOYED } from '@agenticprimitives/contracts/deployments/base-sepolia';

export const CHAIN_ID = 84532;

/** Public Base Sepolia RPC. Override with RPC_URL (server) / VITE_RPC_URL (browser). */
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';

/** Deployed Base Sepolia contracts. Single source of truth:
 *  `packages/contracts/deployments-base-sepolia.json`, surfaced here via
 *  the `@agenticprimitives/contracts/deployments/base-sepolia` subpath. */
export const CONTRACTS = {
  entryPoint: DEPLOYED.entryPoint as Address,
  agentAccountFactory: DEPLOYED.agentAccountFactory as Address,
  agentAccountImplementation: DEPLOYED.agentAccountImplementation as Address,
  agentNameRegistry: DEPLOYED.agentNameRegistry as Address,
  agentNameUniversalResolver: DEPLOYED.agentNameUniversalResolver as Address,
  custodyPolicy: DEPLOYED.custodyPolicy as Address,
  permissionlessSubregistry: DEPLOYED.permissionlessSubregistry as Address,
  agentRelationship: DEPLOYED.agentRelationship as Address,
  // ERC-7710 delegation (ADR-0019: relying site = scoped delegate of the person SA).
  delegationManager: DEPLOYED.delegationManager as Address,
  timestampEnforcer: DEPLOYED.timestampEnforcer as Address,
  allowedTargetsEnforcer: DEPLOYED.allowedTargetsEnforcer as Address,
  allowedMethodsEnforcer: DEPLOYED.allowedMethodsEnforcer as Address,
  valueEnforcer: DEPLOYED.valueEnforcer as Address,
} as const satisfies Record<string, Address>;
