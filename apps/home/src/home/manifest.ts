// Home manifest composition (spec 310 W2). The @agenticprimitives/home package
// owns the SCHEMA; this module is the app-side composer that fills it with this
// deployment's endpoints (from src/lib/domain.ts — the one place hostnames
// live, ADR-0021) and computes the digest the owner signs.
//
// Signing model: the owner's ROOT credential signs the manifest digest exactly
// like a delegation digest (raw-or-EIP-191; AgentAccount ERC-1271 validates
// both passkey and wallet signatures) — the Home renders authority, never
// mints it, and a manifest grants nothing; it only DESCRIBES surfaces.
import { keccak256, stringToBytes } from 'viem';
import type { Address, CanonicalAgentId, Hex } from '@agenticprimitives/types';
import type { HomeManifestV1, ProofRefV1 } from '@agenticprimitives/home';
import { A2A_DOMAIN, personalAuthOrigin } from '../lib/domain';
import { CHAIN_ID } from '../lib/chain';

export type HomeManifestUnsigned = Omit<HomeManifestV1, 'proof'>;

/** CAIP-10 id for an SA on this deployment's chain (ADR-0008/0016). */
export function homeCaip10(address: Address): CanonicalAgentId {
  return `eip155:${CHAIN_ID}:${address.toLowerCase()}` as CanonicalAgentId;
}

/** Default manifest validity — long enough to be useful, short enough that a
 *  stale manifest ages out (spec 310 AUDIT: prefer short windows). */
const VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

/** Compose this deployment's manifest for a person's Home. Deterministic for a
 *  given (label, owner, nowMs) so the client-built draft and any re-derivation
 *  hash identically. */
export function buildHomeManifestDraft(opts: {
  label: string;
  owner: Address;
  nowMs: number;
}): HomeManifestUnsigned {
  const sso = personalAuthOrigin(opts.label);
  const supportedMessageKinds = ['plain', 'request', 'response', 'credential-delivery', 'receipt'];
  const supportedInteractionKinds = [
    'access-request',
    'entitlement-request',
    'approval-request',
    'credential-delivery',
    'revocation-notice',
  ];
  return {
    type: 'ap.home.manifest.v1',
    homeId: `home_${opts.label}`,
    owner: homeCaip10(opts.owner),
    status: 'active',
    endpoints: {
      sso,
      a2a: `https://${opts.label}.${A2A_DOMAIN}/a2a`,
      wellKnown: `${sso}/.well-known/agentic-home`,
    },
    surfaces: [
      { surface: 'identity-entry', level: 'full', endpoint: sso },
      { surface: 'connected-apps', level: 'act' },
      { surface: 'managed-agents', level: 'act' },
      { surface: 'authority-review', level: 'act' },
      // Inbox is declared view-only until the spec 310 W3 inbox surface lands.
      { surface: 'inbox', level: 'view' },
    ],
    capabilities: {
      supportedMessageKinds,
      supportedInteractionKinds,
      supportedCardProfiles: ['agenticprimitives-card-v1'],
    },
    inbox: {
      owner: homeCaip10(opts.owner),
      supportedMessageKinds,
      supportedInteractionKinds,
      supportedCryptoProfiles: ['direct-recipient-encryption'],
      supportedDeliveryProfiles: ['a2a'],
    },
    validFrom: new Date(opts.nowMs).toISOString(),
    validUntil: new Date(opts.nowMs + VALIDITY_MS).toISOString(),
  };
}

/** Canonical JSON: recursively key-sorted, no undefined members. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = stable(v);
    }
    return out;
  }
  return value;
}

/** The digest the owner's ROOT credential signs (and the server re-derives —
 *  the signature never covers itself). */
export function homeManifestDigest(draft: HomeManifestUnsigned): Hex {
  return keccak256(stringToBytes(JSON.stringify(stable(draft))));
}

export function finalizeHomeManifest(draft: HomeManifestUnsigned, proof: ProofRefV1): HomeManifestV1 {
  return { ...draft, proof };
}
