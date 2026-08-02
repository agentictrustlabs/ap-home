// Issue and revoke discovery grants from the Home (spec 338 W6-b, Wave 1).
//
// THE HOME NEVER SIGNS ON THE USER'S BEHALF. Everything here builds a canonical body, hands it to the
// caller's own custody path (`signHashFor` — SIWE EOA / passkey SA / KMS), and posts the signed object
// to `/connect/resolution`, which forwards it to the Workers. The Workers verify that signature
// ON-CHAIN before storing.
//
// That ordering is the whole claim: "the principal authorized this" has to mean the principal's key
// moved, not that the Home asserted it.

import type { Address } from '@agenticprimitives/types';
import { canonicalizeJson } from '@agenticprimitives/types';

/** The `signHashFor` result shape — a function from 32-byte digest to signature. */
export type SignHash = (digest: `0x${string}`) => Promise<`0x${string}`>;

const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s) as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 over canonical JSON — the same digest the Workers recompute. */
async function digestOf(body: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalizeJson(body))}`;
}

const signingDigest = (d: string) => `0x${d.slice('sha256:'.length)}` as `0x${string}`;

export const caip10 = (address: string, chainId: number) => `eip155:${chainId}:${address.toLowerCase()}`;

/** One channel per (agent, audience) — spec 338 §3.1a. */
export const partnerChannel = (agentId: string, subjectId: string) => `${agentId}:partner:${subjectId}`;

/** The delegation an appointed party presents, plus the ref that commits to it (spec 338 §3.1b). */
export interface DiscoveryAuthorityPresentation {
  /** `apdel1:<hashDelegation>` — goes into the SIGNED grant body, pinning WHICH authority was used. */
  authorityRef: string;
  /** The agent the grant is FOR. The delegation's delegator; never the issuer. */
  targetAgent: Address;
  /** The delegation itself, wire form. The resolver re-hashes it and checks the commitment. */
  delegation: unknown;
}

export interface IssueGrantInput {
  /**
   * The ISSUER — whose key signs the grant.
   *
   * Without `authority`, this is also the agent being made discoverable (self-issuance). With it,
   * this is the appointed party and the target comes from the appointment, so the two differ.
   */
  agentAddress: Address;
  /** The party allowed to discover it. */
  subjectAddress: Address;
  chainId: number;
  /** The resolver this grant is bound to — a grant for another resolver is refused there. */
  resolverAudience: string;
  purpose?: string;
  /** Surface ids this party may see. Fail-closed: an empty list discloses nothing. */
  allowedSurfaceIds: string[];
  expiresAt: Date;
  sign: SignHash;
  /**
   * Present to issue for an agent you were APPOINTED over rather than one you hold the key of.
   *
   * Omit and the grant claims self-issuance, which the resolver only honours when issuer === target.
   * There is no third option: an `authorityRef` it cannot parse is denied, never treated as self.
   */
  authority?: DiscoveryAuthorityPresentation;
}

export interface ResolutionApiResult {
  ok: boolean;
  error?: string;
  detail?: string;
  grantDigest?: string;
  /** Present on success — the operator must hand this to the recipient out-of-band. */
  grantId?: string;
}

async function post(body: unknown, token: string): Promise<ResolutionApiResult> {
  const res = await fetch('/connect/resolution', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as ResolutionApiResult;
  if (!res.ok && !out.error) return { ok: false, error: `HTTP ${res.status}` };
  return { ...out, ok: res.ok && out.ok !== false };
}

/**
 * Mint a high-entropy opaque grant id.
 *
 * NOT derived from the agent, the subject, or any label — a name-derived id would reintroduce exactly
 * the guessable pre-image ADR-0056 §4 rejects.
 */
export function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `apd1_${b64}`;
}

/**
 * Build, sign and index a discovery grant.
 *
 * The returned `grantId` is the capability — deliver it to the recipient over a channel you trust.
 * It is never stored anywhere it could be read back, so if it is lost the grant must be reissued.
 */
export async function issueDiscoveryGrant(
  input: IssueGrantInput,
  token: string,
): Promise<ResolutionApiResult> {
  const issuerId = caip10(input.agentAddress, input.chainId);
  // The agent being made discoverable. Under an appointment that is the APPOINTMENT'S target, never
  // the issuer — taking it from the issuer would let a holder retarget the authority at itself.
  const agentId = input.authority
    ? caip10(input.authority.targetAgent, input.chainId)
    : issuerId;
  const subjectId = caip10(input.subjectAddress, input.chainId);
  const grantId = newGrantId();

  const core = {
    specVersion: 'ap.private-resolution-grant/1' as const,
    grantId,
    issuer: issuerId,
    targetAgent: agentId,
    subject: subjectId,
    mode: 'subject-bound' as const,
    actions: ['agent.resolve'],
    projection: {
      profile: 'partner',
      allowedSurfaceIds: input.allowedSurfaceIds,
    },
    constraints: {
      audience: input.resolverAudience,
      purpose: input.purpose,
      notBefore: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      // MUST be true for subject-bound — otherwise a copied grant would work for anyone.
      requireProofOfPossession: true,
    },
    statusRef: `home://grant-status/${grantId}`,
    issuedAt: new Date().toISOString(),
    // '' claims self-issuance; `apdel1:<hashDelegation>` commits to the appointment used. Because the
    // ref is INSIDE the body being signed below, the issuer commits to which authority it acted
    // under — presenting a different delegation later, even a valid one, fails at the resolver.
    authorityRef: input.authority?.authorityRef ?? '',
  };

  // The issuer's own key signs. The Home only carries the result.
  const proof = await input.sign(signingDigest(await digestOf(core)));

  const result = await post(
    { action: 'issue', grant: { ...core, proof }, delegation: input.authority?.delegation },
    token,
  );
  return result.ok ? { ...result, grantId } : result;
}

/**
 * Revoke a grant.
 *
 * Takes the raw grant id because the operator holds it; the resolver stores only its keyed digest.
 * Revoking discovery does NOT revoke any delegation — those are independent controls (ADR-0056).
 */
export async function revokeDiscoveryGrant(grantId: string, token: string): Promise<ResolutionApiResult> {
  return post({ action: 'revoke', grantId }, token);
}

/** Read a channel's current publications. The channel id is itself the capability (spec 338 §9). */
export async function readChannelPublications(channelId: string): Promise<unknown[]> {
  const res = await fetch(`/connect/resolution?channelId=${encodeURIComponent(channelId)}`);
  const out = await res.json().catch(() => []);
  return Array.isArray(out) ? out : [];
}
