// CARD TRUST (spec 445 RUN-16) — a card this runtime ROUTES BY is the agent's own word or it is not used.
//
// A card fetched from a name's records is served by whoever stands at that URL. Before an endpoint taken from it receives
// anything, the card must be pinned by the digest the name publishes, or its signature must verify against the key the
// AGENT bound on chain. This binds a2a's `verifyCardSignature` port to `createOnChainCardVerifier` (agent-profile):
//   · the expected agent is the name's on-chain `addr` record — never the card, never the binding;
//   · the binding (`/.well-known/agent-card-binding.json`) must verify BY THAT AGENT through the UniversalSignatureValidator
//     on the declared chain, and name this card's digests; the card's JWS must be signed by the key the binding names
//     (`/.well-known/jwks.json`, picked by RFC 7638 thumbprint only);
//   · anything missing or unreadable is "not verified" — the card is refused, never relied on.
// Verified is evidence about whose card it is; it grants nothing (a verified card still cannot spend or act).
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { createOnChainCardVerifier, type CardBindingLocationV1 } from '@agenticprimitives/agent-profile/a2a';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { CardTrustOptions } from '@agenticprimitives/a2a/standard';
import { chainFor, chainIdOf } from './chain';

const DOC_MAX_BYTES = 64 * 1024;

export interface CardTrustDeps {
  chainId: number;
  /** UniversalSignatureValidator `isValidSig` — ECDSA / ERC-1271 / ERC-6492. */
  verifyHash: (signer: Address, digest: Hex, signature: Hex) => Promise<boolean>;
  /** The agent the name's ON-CHAIN `addr` record names, or null when the registry knows no such name. */
  addrOf: (name: string) => Promise<string | null>;
  fetch: typeof fetch;
}

/** One bounded JSON read of a card host's well-known document: https only, no redirect, small, JSON or null. */
async function jsonDoc(f: typeof fetch, url: string): Promise<unknown | null> {
  try {
    if (!/^https:\/\//.test(url)) return null;
    const r = await f(url, { redirect: 'manual', headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > DOC_MAX_BYTES) return null;
    return JSON.parse(text);
  } catch { return null; }
}

/** The trust options for routing by `name`'s card at `cardUrl`: rely on it only if its signature verifies on chain. */
export function cardTrustFor(deps: CardTrustDeps, name: string, cardUrl: string): CardTrustOptions {
  const verifyCardSignature = createOnChainCardVerifier({
    chainId: deps.chainId,
    verifyHash: deps.verifyHash,
    locate: async (): Promise<CardBindingLocationV1 | null> => {
      const smartAgent = await deps.addrOf(name.toLowerCase());
      if (!smartAgent || !/^0x[0-9a-fA-F]{40}$/.test(smartAgent)) return null;
      const origin = new URL(cardUrl).origin;
      const binding = await jsonDoc(deps.fetch, `${origin}/.well-known/agent-card-binding.json`);
      const jwks = await jsonDoc(deps.fetch, `${origin}/.well-known/jwks.json`) as { keys?: unknown } | null;
      if (!binding || !Array.isArray(jwks?.keys)) return null;
      return { smartAgent: smartAgent as Address, cardUri: cardUrl, binding: binding as CardBindingLocationV1['binding'], keys: jwks!.keys as CardBindingLocationV1['keys'] };
    },
  });
  return { relyOnCard: true, verifyCardSignature };
}

export interface CardTrustEnv {
  RPC_URL?: string; CHAIN_ID?: string; UNIVERSAL_SIGNATURE_VALIDATOR?: string;
  AGENT_NAME_REGISTRY?: string; AGENT_NAME_UNIVERSAL_RESOLVER?: string; PROFILE_RESOLVER?: string;
}

/** Bind this deployment's chain reads; null when the validator or the registry is not configured (then no card is relied on). */
export function cardTrustForEnv(env: CardTrustEnv, fetchImpl: typeof fetch): ((name: string, cardUrl: string) => CardTrustOptions) | null {
  const usv = env.UNIVERSAL_SIGNATURE_VALIDATOR?.trim();
  if (!env.RPC_URL || !usv || !env.AGENT_NAME_REGISTRY || !env.AGENT_NAME_UNIVERSAL_RESOLVER) return null;
  const pub = createPublicClient({ chain: chainFor(env as never), transport: http(env.RPC_URL) });
  const naming = new AgentNamingClient({ rpcUrl: env.RPC_URL, chainId: Number(env.CHAIN_ID), registry: env.AGENT_NAME_REGISTRY as Address, universalResolver: env.AGENT_NAME_UNIVERSAL_RESOLVER as Address, ...(env.PROFILE_RESOLVER ? { profileResolver: env.PROFILE_RESOLVER as Address } : {}) });
  const deps: CardTrustDeps = {
    chainId: chainIdOf(env as never),
    verifyHash: async (signer, digest, signature) => (await pub.readContract({ address: usv as Address, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [signer, digest, signature] })) === true,
    addrOf: async (name) => (await naming.resolveName(name).catch(() => null)) ?? null,
    fetch: fetchImpl,
  };
  return (name, cardUrl) => cardTrustFor(deps, name, cardUrl);
}
