// General (domain-agnostic) ALLIANCE MEMBERSHIP — uupg-interop port of the GC impact home's
// alliance-store. An alliance is an org that hosts a MEMBERS ROSTER — the "collective capability"
// primitive. The roster lives in the ALLIANCE'S OWN vault (record `impact-alliance-members`),
// read/written over the alliance's stewardship delegation wire (custody ≠ access — the write is
// delegation-gated; the relayer mints sub = the alliance, so the record lands in ITS vault). A
// relying app (e.g. a coalition tracker) layers its own domain meaning on top; the home knows only
// "these member orgs belong to this alliance".
//
// Adaptation from impact: impact routed reads/writes through its AccessContext abstraction; this
// repo's equivalent is the raw stewardship DelegationWire + vaultReadWithDelegation /
// vaultWriteWithDelegation (src/lib/vault-client.ts), so the wire is the context.
import type { Address } from '@agenticprimitives/types';
import type { DelegationWire } from './delegation';
import { vaultReadWithDelegation, vaultWriteWithDelegation } from './vault-client';

export const ALLIANCE_MEMBERS_RECORD = 'impact-alliance-members';

export interface AllianceMember {
  sa: Address;
  name: string;
  ts: number;
}
export interface AllianceMembers {
  v: 1;
  members: AllianceMember[];
}

/** Read the alliance's member-org roster (empty when the alliance was just created / never provisioned).
 *  `stewardship` = the alliance's org→person stewardship delegation wire (delegator = the alliance). */
export async function loadAllianceMembers(stewardship: DelegationWire): Promise<AllianceMember[]> {
  const rec = await vaultReadWithDelegation<AllianceMembers>(stewardship, ALLIANCE_MEMBERS_RECORD);
  return Array.isArray(rec?.members) ? rec!.members : [];
}

/** Add a member org to the alliance's roster (idempotent by SA). Whole-record replace, `{v:1,…}`. */
export async function addAllianceMember(
  stewardship: DelegationWire,
  member: { sa: Address; name: string },
  nowSeconds: number,
): Promise<AllianceMember[]> {
  const members = await loadAllianceMembers(stewardship);
  if (!members.some((m) => m.sa.toLowerCase() === member.sa.toLowerCase())) {
    members.push({ sa: member.sa, name: member.name, ts: nowSeconds });
  }
  await vaultWriteWithDelegation(stewardship, ALLIANCE_MEMBERS_RECORD, { v: 1, members } satisfies AllianceMembers);
  return members;
}
