// Community directory helpers (spec 312 §4.4 / W3). A listing is the person's
// OPT-IN, self-signed, revocable choice to be discoverable in a community
// context (ADR-0025: membership is never inferred; only listings are shown).
// The digest is recomputed server-side before ERC-1271 verification — a
// client-supplied digest is never trusted.
import type { DirectoryListingV1 } from '@agenticprimitives/home';
import { canonicalizeMessage, sha256Hex32 } from '@agenticprimitives/messaging';
import type { Address, Hex } from '@agenticprimitives/types';
import { homeCaip10 } from './manifest';

type SignHash = (hash: Hex) => Promise<Hex>;

export type ListingUnsigned = Omit<DirectoryListingV1, 'proof'>;

export async function listingDigest(draft: ListingUnsigned): Promise<Hex> {
  return sha256Hex32(canonicalizeMessage(draft));
}

/** Build + sign a listing for a community context under the person's SA. */
export async function issueDirectoryListing(
  person: Address,
  signHash: SignHash,
  opts: {
    communityId: string;
    communityLabel?: string;
    displayName: string;
    roles?: string[];
    validityDays?: number;
  },
): Promise<DirectoryListingV1> {
  const me = homeCaip10(person);
  const now = Date.now();
  const draft: ListingUnsigned = {
    type: 'ap.home.directory-listing.v1',
    subject: me,
    context: { kind: 'community', id: opts.communityId, label: opts.communityLabel },
    displayName: opts.displayName,
    roles: opts.roles,
    visibility: 'community',
    publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.validityDays ?? 180) * 86_400_000).toISOString(),
  };
  const signature = await signHash(await listingDigest(draft));
  return { ...draft, proof: { signer: me, scheme: 'erc1271', signature } };
}
