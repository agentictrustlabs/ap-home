// WHAT THIS PERSON IS TO THAT AGENT — spec 353 S5, derived and never asserted.
//
// The Ask reaches a point where it must say "this needs authority as Calvary". Whether the person in front
// of it can GIVE that authority is knowable, and saying nothing is the cruel option: they sign, the
// verifier reads the signature against an SA their credential does not custody, and the run comes back
// `not-live` — true, unhelpful, and after the fact.
//
// DERIVED, NOT ASSERTED. An app that told us "this person is a steward" would be supplying an
// authorization claim, which is the pattern ADR-0041 forbids and spec 353 §2 excludes from the scope
// payload on purpose. So standing comes from evidence the PERSON holds and the CHAIN confirms:
//
//   self       the subject IS them — nothing to check.
//   steward    they hold a stewardship delegation from that agent, in their own vault, which is
//              ERC-1271-valid against it and unrevoked on chain. A delegation of the right SHAPE:
//              governance targets and no vault-record scope, or a member's data grant could be replayed
//              as stewardship (the SEC-C1 parity check the Home already makes).
//   member     they are in that agent's roster — standing to be there, not to authorize.
//   none       no link. Not a refusal by itself: the Ask still asks, and the chain still decides.
//
// AND IT IS NOT AUTHORITY. Standing shapes what we SAY before a ceremony — who can grant, and who to ask
// if it is not you. It is not consulted by any gate: a steward reading of this record grants nothing that
// the mandate and the chain would not have granted anyway (spec 353 §4).
import { relationshipRows } from './relationship-rows.js';
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import type { Address, Hex } from 'viem';

export type StandingRelation = 'self' | 'steward' | 'member' | 'none';

export interface Standing {
  subject: Address;
  relation: StandingRelation;
  /** What we read to say so — quotable in the sentence a person is shown. */
  because: string;
  /** Can this person mint the mandate themselves? `self` and a verified `steward` can. */
  canGrant: boolean;
}

export interface StandingDeps {
  /** Read one record from a subject's own vault (the asker's private tier). */
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  /** Is this stewardship wire real: right shape, ERC-1271-valid against the org, unrevoked? */
  verifyStewardship?: (input: { org: Address; person: Address; wire: unknown }) => Promise<boolean>;
}

const lc = (s: string) => s.toLowerCase();

/**
 * What `principal` is to `subject`.
 *
 * Order matters and is not an optimisation: the stewardship wire is CHECKED before it is believed. A row
 * in someone's own vault saying `relationship: 'steward'` is their own note about themselves — useful, and
 * not evidence. The wire is the evidence, and it is only evidence once the chain agrees.
 */
/** The stewardship check, built from the chain reads the mandate path already makes.
 *
 * SHAPE FIRST, and it is not a formality (SEC-C1 parity with the Home's `verifyStewardship`): a member's
 * vault-record grant is also a real, signed, unrevoked delegation from the org to the person. What makes
 * one of them stewardship is that it names GOVERNANCE targets and carries no record scope. Skip the shape
 * check and every member holding a data grant reads as a steward.
 */
export function chainStewardshipCheck(input: {
  readContract: (args: never) => Promise<unknown>;
  chainId: number;
  delegationManager: Address;
  allowedTargetsEnforcer?: string;
  vaultRecordScopeEnforcer?: string;
  isRevokedAbi: unknown;
  validator?: Address;
  validatorAbi: unknown;
}): NonNullable<StandingDeps['verifyStewardship']> {
  const low = (v?: string) => (v ?? '').toLowerCase();
  return async ({ org, person, wire }) => {
    const w = wire as (Delegation & { salt?: unknown }) | null;
    if (!w?.signature || !Array.isArray(w.caveats)) return false;
    if (low(w.delegator) !== low(org) || low(w.delegate) !== low(person)) return false;
    const enf = (c: { enforcer?: string }) => low(c.enforcer);
    const governance = !!input.allowedTargetsEnforcer && w.caveats.some((c) => enf(c) === low(input.allowedTargetsEnforcer));
    const recordScope = !!input.vaultRecordScopeEnforcer && w.caveats.some((c) => enf(c) === low(input.vaultRecordScopeEnforcer));
    if (!governance || recordScope) return false;
    if (!input.validator) return false;
    // A record in someone's vault is data, not a promise of a well-formed delegation. Hashing malformed
    // input throws, and a throw here would take down an ask that was only ever asking a question.
    let digest: `0x${string}`;
    try {
      digest = hashDelegation({ ...w, salt: BigInt(w.salt as unknown as string) } as Delegation, input.chainId, input.delegationManager);
    } catch { return false; }
    const valid = await input.readContract({
      address: input.validator, abi: input.validatorAbi, functionName: 'isValidSig',
      args: [org, digest, w.signature],
    } as never).catch(() => false);
    if (valid !== true) return false;
    // A revoked wire is not stewardship. An unreadable revocation state is not "probably fine" either:
    // failing closed here costs a person one honest sentence, failing open costs them a wasted ceremony.
    const revoked = await input.readContract({
      address: input.delegationManager, abi: input.isRevokedAbi, functionName: 'isRevoked', args: [digest],
    } as never).catch(() => true);
    return revoked !== true;
  };
}

export async function deriveStanding(
  deps: StandingDeps,
  input: { principal: Address; subject: Address },
): Promise<Standing> {
  const subject = lc(input.subject) as Address;
  if (lc(input.principal) === subject) {
    return { subject, relation: 'self', because: 'this is your own agent', canGrant: true };
  }
  if (!deps.readSubjectRecord) {
    return { subject, relation: 'none', because: 'this agent cannot read your links', canGrant: false };
  }

  // NOT caught. "I could not read your links" and "you have no link" are opposite facts, and this function
  // returns only the second — the caller reports the first as unavailable. Swallowing the read here would
  // tell a steward, in confident words, that they have no standing in their own organization.
  const tree = await deps.readSubjectRecord(input.principal, 'relationships.data');
  const row = relationshipRows(tree).find((r) => r.agent === subject);
  const name = row?.name ?? subject;

  // Their own row saying `relationship: 'steward'` is a note about themselves. The WIRE is the evidence.
  if (row?.relationship === 'steward' && row.stewardshipDelegation && deps.verifyStewardship) {
    const ok = await deps
      .verifyStewardship({ org: subject, person: input.principal, wire: row.stewardshipDelegation })
      .catch(() => false);
    // A wire that does not verify is NOT downgraded quietly to "steward, unverified": it is not stewardship.
    if (ok) return { subject, relation: 'steward', because: `you hold a stewardship grant from ${name}`, canGrant: true };
  }
  if (row) {
    return { subject, relation: 'member', because: `you are linked to ${name}, but not as a steward`, canGrant: false };
  }

  // Not in their tree: they may still be in its roster (a member who keeps no link of their own). A roster
  // we cannot read is likewise not an absence — `none` here must mean "looked everywhere, found nothing".
  const dir = await deps.readSubjectRecord(subject, 'directory.data');
  const listings = ((dir as { listings?: Array<{ smartAgent?: string; agent?: string }> } | null)?.listings ?? []);
  if (listings.some((l) => lc(String(l.smartAgent ?? l.agent ?? '')) === lc(input.principal))) {
    return { subject, relation: 'member', because: 'you are a member there, but not a steward', canGrant: false };
  }
  return { subject, relation: 'none', because: 'you have no link to that agent', canGrant: false };
}

/** The sentence to show when authority is needed as an agent the person cannot grant for. Names what they
 *  ARE and what would have to happen — "you cannot" without "and here is who can" is a dead end. */
export function standingNote(standing: Standing, capabilityWords: string): string {
  if (standing.canGrant) return '';
  if (standing.relation === 'member') {
    return `This needs ${capabilityWords} as that agent, and ${standing.because} — a steward has to authorize it.`;
  }
  return `This needs ${capabilityWords} as that agent, and ${standing.because}.`;
}
