// The chain + contract table this Home build targets. Base Sepolia (84532) by default —
// the deployed configuration — but selectable per build so the SAME app runs against a
// local chain (anvil, or a private QBFT chain such as faithnet) for development and e2e.
//
// Selection (all build-time; NEXT_PUBLIC_* is inlined into the client bundle):
//   NEXT_PUBLIC_CHAIN_ID        chain id (default 84532)
//   NEXT_PUBLIC_RPC_URL         browser-side RPC default (server code still prefers env.RPC_URL)
//   NEXT_PUBLIC_CONTRACTS_JSON  a `deployments-<network>.json` document as ONE JSON string. Local
//                               deployments are machine-specific and gitignored, so they are injected
//                               here rather than imported — `scripts/gen-dev-vars.ts` writes it.
//
// R7.3: the Base Sepolia addresses come from the @agenticprimitives/contracts package's generated
// deployments module so a contracts redeploy auto-propagates here without any per-app sync (this
// used to require touching three chain.ts files in lockstep — see 2026-06-01 deploy session).

import { defineChain, type Chain } from 'viem';
import { baseSepolia } from 'viem/chains';
import type { Address } from '@agenticprimitives/types';
import { CONTRACTS as BASE_SEPOLIA } from '@agenticprimitives/contracts/deployments/base-sepolia';

type DeploymentsDoc = Record<string, string | number | undefined> & { chainId?: number; deploymentEpoch?: string };

function parseInjected(raw: string | undefined): DeploymentsDoc | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as DeploymentsDoc;
    return d && typeof d === 'object' ? d : null;
  } catch {
    throw new Error('NEXT_PUBLIC_CONTRACTS_JSON is not valid JSON');
  }
}

const INJECTED = parseInjected(process.env.NEXT_PUBLIC_CONTRACTS_JSON);

export const CHAIN_ID: number = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? INJECTED?.chainId ?? baseSepolia.id);
if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) throw new Error(`NEXT_PUBLIC_CHAIN_ID is not a positive integer`);

/** RPC default. Public Base Sepolia on the deployed chain; a local node otherwise. Override with
 *  RPC_URL (server) / NEXT_PUBLIC_RPC_URL (browser). */
export const DEFAULT_RPC_URL: string =
  process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === baseSepolia.id ? 'https://sepolia.base.org' : 'http://127.0.0.1:8545');

/** The viem Chain object every client in this app should be built with (never `baseSepolia` directly:
 *  a client whose chain id differs from the node's signs transactions the node rejects). */
export const CHAIN: Chain =
  CHAIN_ID === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id: CHAIN_ID,
        name: `chain-${CHAIN_ID}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
      });

/** CAIP-2 network id for this chain (`eip155:<id>`). */
/** Human-readable network name for wallet_addEthereumChain (the MetaMask "add network" UI). */
export const CHAIN_NAME: string =
  process.env.NEXT_PUBLIC_CHAIN_NAME ?? (CHAIN_ID === baseSepolia.id ? 'Base Sepolia' : `Chain ${CHAIN_ID}`);

export const CAIP2_NETWORK = `eip155:${CHAIN_ID}` as const;

/**
 * Where to look an address up on a block explorer, for THIS chain.
 *
 * Three components each declared their own `const EXPLORER = 'https://sepolia.basescan.org/address/'` —
 * correct on Base Sepolia and wrong everywhere else, so on another chain every "explorer ↗" link sent a
 * person to a scanner that has never heard of the address they clicked. Chain-derived here, overridable
 * per deployment; empty when the chain has no explorer, and callers render no link rather than a broken
 * one.
 */
export const EXPLORER: string =
  process.env.NEXT_PUBLIC_EXPLORER_ADDRESS_BASE
  ?? (CHAIN_ID === baseSepolia.id ? 'https://sepolia.basescan.org/address/' : '');

const DEPLOYED: DeploymentsDoc = INJECTED ?? (BASE_SEPOLIA as unknown as DeploymentsDoc);
if (INJECTED && INJECTED.chainId != null && Number(INJECTED.chainId) !== CHAIN_ID) {
  throw new Error(`NEXT_PUBLIC_CONTRACTS_JSON is for chain ${INJECTED.chainId}, but CHAIN_ID is ${CHAIN_ID}`);
}

/** Spec 311 — authority deployment epoch of the contracts this build targets. */
export const DEPLOYMENT_EPOCH: string | undefined = DEPLOYED.deploymentEpoch;

const addr = (k: string): Address => (DEPLOYED[k] ?? '0x0000000000000000000000000000000000000000') as Address;

/** Deployed contracts for CHAIN_ID. Single source of truth: `packages/contracts/deployments-<network>.json`
 *  (Base Sepolia via the `@agenticprimitives/contracts/deployments/base-sepolia` subpath; anything else via
 *  NEXT_PUBLIC_CONTRACTS_JSON). Keys absent from a local deployment resolve to the zero address. */
export const CONTRACTS = {
  entryPoint: addr('entryPoint'),
  agentAccountFactory: addr('agentAccountFactory'),
  agentAccountImplementation: addr('agentAccountImplementation'),
  agentNameRegistry: addr('agentNameRegistry'),
  agentNameUniversalResolver: addr('agentNameUniversalResolver'),
  agentNameResolver: addr('agentNameResolver'),
  agentProfileResolver: addr('agentProfileResolver'),
  custodyPolicy: addr('custodyPolicy'),
  permissionlessSubregistry: addr('permissionlessSubregistry'),
  agentRelationship: addr('agentRelationship'),
  // ERC-7710 delegation (ADR-0019: relying site = scoped delegate of the person SA).
  delegationManager: addr('delegationManager'),
  timestampEnforcer: addr('timestampEnforcer'),
  allowedTargetsEnforcer: addr('allowedTargetsEnforcer'),
  allowedMethodsEnforcer: addr('allowedMethodsEnforcer'),
  valueEnforcer: addr('valueEnforcer'),
  // spec 272/243 — PaymentEnforcer gates an x402 payment delegation (treasury → treasury):
  // per-charge + aggregate caps, transfer-only, single-use nonce, payee-bound.
  paymentEnforcer: addr('paymentEnforcer'),
  // spec 253 — the org-create ceremony batches approveHash(digest) for its outbound
  // grants into the deploy userOp; the SA's isValidSignature 0x03 branch consults this.
  approvedHashRegistry: addr('approvedHashRegistry'),
  // Demo USDC (spec 272/243) — the treasury views read its balanceOf for each treasury SA.
  mockUsdc: addr('mockUsdc'),
  // spec 279 — AgentRegistryBase: the SA-anchored discovery registry the Registry tab reads
  // (registry entries per named agent) + registers named agents into.
  agentRegistryBase: addr('agentRegistryBase'),
} as const satisfies Record<string, Address>;

/** spec 346 — per-suffix PermissionlessSubregistry map (`me org team svc workspace treasury registry`), present only on
 *  deployments where `AddTypedRoots.s.sol` has run. An absent suffix means "no typed claim on this chain" — never a
 *  fall-back to the legacy subregistry. */
export const PERMISSIONLESS_SUBREGISTRIES: Partial<Record<string, Address>> =
  ((DEPLOYED as unknown as { permissionlessSubregistries?: Record<string, string> }).permissionlessSubregistries ?? {}) as Partial<Record<string, Address>>;
