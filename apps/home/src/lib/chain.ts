// Base Sepolia (chain 84532) config for the REAL Connect directory (spec 227).
// Addresses are the deployed contracts in packages/contracts/deployments-base-sepolia.json
// (public on-chain addresses — safe to inline; that file remains the source of truth).
// Spec 227 F2/P1-D: the real experience runs on 84532, NOT the old broker-core CHAIN=8453.

import type { Address } from '@agenticprimitives/types';

export const CHAIN_ID = 84532;

/** Public Base Sepolia RPC. Override with RPC_URL (server) / VITE_RPC_URL (browser). */
export const DEFAULT_RPC_URL = 'https://sepolia.base.org';

/** Deployed Base Sepolia contracts (from deployments-base-sepolia.json). */
export const CONTRACTS = {
  entryPoint: '0x094700EB9F743F462b0E59a68084d6be56F3Ed96',
  agentAccountFactory: '0x7Aac638824014210349497440D3CE631A95b466c',
  agentAccountImplementation: '0x235FD455040874B224A671456DA06221868a9CA1',
  agentNameRegistry: '0xE9Bf4f67701Ba6eD7843b9848c3fe0C6e0212427',
  agentNameUniversalResolver: '0xb66a4829606C4E1C5eB424314b681343c747b4B2',
  custodyPolicy: '0xfdbCB192182712C996a1Ed2FB74D0FE6e7d9db26',
  permissionlessSubregistry: '0xC5060624c6C8Ed9E453b6693111eC8f40eDe8110', // .impact subregistry (was demo.agent)
  agentRelationship: '0xB85BA211d6528BE2561a41b629537e5054B648DF',
  // ERC-7710 delegation (ADR-0019: relying site = scoped delegate of the person SA).
  delegationManager: '0xaEb6191FFa086a0288A6367eC5D816344A6089f2',
  timestampEnforcer: '0xb164Cc23A37b7EB84b2788F8906C506b12EFEc99',
  allowedTargetsEnforcer: '0xe16f0185348283574500a6721A91526ec27da83f',
  allowedMethodsEnforcer: '0x0229763ACb6AAaC5e99DFf20d0c44B6E34D5503D',
  valueEnforcer: '0xeC1365428bbF42Ab8dEE80a3C1aba21Fc3014f60',
} as const satisfies Record<string, Address>;
