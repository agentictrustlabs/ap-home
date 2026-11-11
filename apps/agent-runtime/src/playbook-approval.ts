// PLAYBOOK APPROVAL (spec 445 RUN-14, owner decision 8) — WHO APPROVED THIS DIGEST.
// `loadPlaybook` proves a stored definition is internally consistent (its body hashes to the digest written beside it);
// whoever can write an agent's `archetype.assignment` writes both. So a playbook runs only when its digest is one this
// DEPLOYMENT pinned: the `definitions` block of `agentic.lock.json` (the same digests the committed definition
// snapshots are compiled to). The record's writer does not control this set — it ships with the bundle.
// A digest not in the set is refused (the bare harness stands, said in the log); there is no default-allow.
// Behaviour honesty, never authority: no verifier consults this.
import lock from '../../../agentic.lock.json';

type LockDefinition = { digest?: string };

const PINNED: ReadonlySet<string> = new Set(
  Object.values((lock as { definitions?: Record<string, LockDefinition> }).definitions ?? {})
    .map((d) => (typeof d?.digest === 'string' ? d.digest.toLowerCase() : ''))
    .filter((d) => /^0x[0-9a-f]{64}$/.test(d)),
);

/** True iff `digest` is one the deployment pinned. */
export function isPinnedDigest(digest: string): boolean {
  return PINNED.has(String(digest ?? '').toLowerCase());
}

/** The `isApproved` port `loadPlaybook` requires. */
export const isApproved = (input: { agent: string; digest: string; archetypeId: string; archetypeVersion: string }): boolean =>
  isPinnedDigest(input.digest);
