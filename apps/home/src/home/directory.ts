// Community directory helpers (spec 312 §4.4 / W3). A listing is the person's
// OPT-IN, self-signed, revocable choice to be discoverable in a community
// context (ADR-0025: membership is never inferred; only listings are shown).
// The digest is recomputed server-side before ERC-1271 verification — a
// client-supplied digest is never trusted.
import type { DirectoryListingV1 } from '@agenticprimitives/fabric/messaging';
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/fabric/messaging';
import type { Address, Hex } from '@agenticprimitives/types';
import { homeCaip10 } from './manifest';

type SignHash = (hash: Hex) => Promise<Hex>;

export type ListingUnsigned = Omit<DirectoryListingV1, 'proof'>;

export async function listingDigest(draft: ListingUnsigned): Promise<Hex> {
  return sha256Hex32(canonicalizeMessage(draft));
}

/**
 * Build + sign a listing. `subject` defaults to the signer's own SA; a steward
 * may pass their ORG's address (spec 313 Networks) — the server verifies the
 * signature against the SUBJECT SA, so this only works when the signing
 * credential actually controls that account.
 */
export async function issueDirectoryListing(
  signerAgent: Address,
  signHash: SignHash,
  opts: {
    communityId: string;
    communityLabel?: string;
    displayName: string;
    roles?: string[];
    validityDays?: number;
    subject?: Address;
    contextKind?: string;
    visibility?: 'community' | 'public';
    /** spec 329 §2.2 — the org-scoped consultability HINT (aporg:consultable). Set at the opt-in
     *  ceremony alongside the member→org consult delegation (the authority); cleared by
     *  re-publishing without it. Absent ⇒ false. */
    consultable?: boolean;
  },
): Promise<DirectoryListingV1> {
  const subject = homeCaip10(opts.subject ?? signerAgent);
  const now = Date.now();
  const draft: ListingUnsigned = {
    type: 'ap.home.directory-listing.v1',
    subject,
    context: { kind: opts.contextKind ?? 'community', id: opts.communityId, label: opts.communityLabel },
    displayName: opts.displayName,
    roles: opts.roles,
    ...(opts.consultable ? { consultable: true } : {}),
    visibility: opts.visibility ?? 'community',
    publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.validityDays ?? 180) * 86_400_000).toISOString(),
  };
  const signature = await signHash(await listingDigest(draft));
  return { ...draft, proof: { signer: subject, scheme: 'erc1271', signature } };
}
