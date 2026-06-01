// Base Sepolia (chain 84532) config for the REAL Connect directory (spec 227).
// Addresses are the deployed contracts in packages/contracts/deployments-base-sepolia.json
// (public on-chain addresses — safe to inline; that file remains the source of truth).
// Spec 227 F2/P1-D: the real experience runs on 84532, NOT the old broker-core CHAIN=8453.

import type { Address } from '@agenticprimitives/types';

export const CHAIN_ID = 84532;

/** Public Base Sepolia RPC. Override with RPC_URL (server) / VITE_RPC_URL (browser). */
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';

/** Deployed Base Sepolia contracts (from deployments-base-sepolia.json).
 *  REFRESHED after the R6 contracts hardening wave (R6.5/R6.6/R6.8 pause
 *  + naming governance redeploy on 2026-06-01).
 *  Source of truth: packages/contracts/deployments-base-sepolia.json. */
export const CONTRACTS = {
  entryPoint: '0x30F0cC9C7d71033e85A0b073beF24F4aE8735024',
  agentAccountFactory: '0x47CC94C4600cb4b7EAb12316f6827ba5b242D34E',
  agentAccountImplementation: '0x5916d980413ff28333b02a77a0aCAc8eb63Bebd9',
  agentNameRegistry: '0xc8651c926CAEb10495d36A60979D1eE1b4CF3356',
  agentNameUniversalResolver: '0x47E76fd861392c0Ac9Fc340065EAF8E18398Ac58',
  custodyPolicy: '0xb40e4cBEe5c6F4AB4db632051Db0dc897706a040',
  permissionlessSubregistry: '0x0A2fa51eeE86fE78E905Cf9a0ef45CEbf73F7623',
  agentRelationship: '0x65c627ACc4d64528D3a1944b5f2904eacA02e374',
  // ERC-7710 delegation (ADR-0019: relying site = scoped delegate of the person SA).
  delegationManager: '0x3C78c80EBbCEF219CF4D5E6e275782455D4831AF',
  timestampEnforcer: '0x703b752B0d68944ed1fBdD5509751E02841125B9',
  allowedTargetsEnforcer: '0x9a01D29bA6C538d38FD8e8Dd5B68B6EcD87C0159',
  allowedMethodsEnforcer: '0xBdcc46831841b5194769DF6fae050fFc0afD85A3',
  valueEnforcer: '0x7579da6575F8b8657b3DF98E216709c6A8bF65F4',
} as const satisfies Record<string, Address>;
