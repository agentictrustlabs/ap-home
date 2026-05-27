// The REAL Base Sepolia directory for the Connect broker (spec 227 Phase A).
// Replaces the in-memory fakes + the Google->Alice catch-all of `buildDemoDirectory`
// with live ports. Resolution doctrine (ADR-0013/0015/0017, spec 227 §5):
//
//  - NamingPort: on-chain `resolveName` / `reverseResolve` via AgentNamingClient
//    (one mechanism, null is terminal — no fallback).
//  - OnChainReadPort.confirmsCredential = a custody MEMBERSHIP check:
//      * siwe-eoa / hardware -> AgentAccount.isCustodian(signerAddress)  (onchain-confirmed)
//      * oidc -> ALWAYS false (P0-B / ADR-0017: OIDC is NEVER an on-chain custodian;
//        it is a login-grade facet confirmed only by the indexer).
//      * passkey -> needs the registered (x,y) -> PIA -> isCustodian(PIA); the
//        principal carries only a credential id, so this requires the PIA map wired
//        at bootstrap (spec 227 U2). Returns false until then — fail-closed, NEVER a
//        silent confirm.
//  - IndexerPort (injected): proposes (iss,sub)->agent + credential->agent; the
//    on-chain port confirms (audit P1-3). Default: empty in-memory (server passes a
//    KV-backed port).

import {
  createDirectory,
  type IdentityDirectory,
  type IndexerPort,
} from '@agenticprimitives/identity-directory';
import {
  makeNamingPort,
  makeOnChainReadPort,
  createInMemoryIndexer,
  addressOf,
} from '@agenticprimitives/identity-directory-adapters';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import type { Address } from '@agenticprimitives/types';
import type { Hex } from 'viem';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from './chain';

export interface RealDirectoryOpts {
  /** Base Sepolia RPC (server: env.RPC_URL; browser: import.meta.env.VITE_RPC_URL). */
  rpcUrl?: string;
  /** Login-facet indexer (server: a KV-backed port; default: empty in-memory). */
  indexer?: IndexerPort;
}

/** Build the real, on-chain-backed Base Sepolia directory (spec 227 §5). */
export function buildRealDirectory(opts: RealDirectoryOpts = {}): IdentityDirectory {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;

  const naming = new AgentNamingClient({
    rpcUrl,
    chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry,
    universalResolver: CONTRACTS.agentNameUniversalResolver,
  });

  const accounts = new AgentAccountClient({
    rpcUrl,
    chainId: CHAIN_ID,
    entryPoint: CONTRACTS.entryPoint,
    factory: CONTRACTS.agentAccountFactory,
  });

  return createDirectory({
    naming: makeNamingPort({ client: naming, chainId: CHAIN_ID }),
    onChain: makeOnChainReadPort({
      exists: (id) => accounts.isDeployed(addressOf(id)),
      confirmsCredential: async (id, p) => {
        // OIDC is NEVER an on-chain custodian (P0-B / ADR-0017): login-grade only,
        // confirmed by the indexer, not here.
        if (p.kind === 'oidc') return false;
        const account = addressOf(id);
        // passkey: keyed on its credentialIdDigest -> AgentAccount.hasPasskey (U2).
        if (p.kind === 'passkey') return accounts.hasPasskey(account, p.id as Hex);
        // EOA / hardware: the principal id IS the on-chain signer address.
        return accounts.isCustodian(account, p.id as Address);
      },
    }),
    indexer: opts.indexer ?? createInMemoryIndexer([]),
  });
}
