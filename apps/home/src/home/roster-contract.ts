// THE ROSTER, PER PARTICIPANT — spec 398 §4.5: type · sponsor (who admitted them and under what situation, 324) ·
// responsibility (344 — never a basis) · permissions summary (their grants, plain words) · active work (items where
// they are executor). Projected from the two views of membership the roster already unions (a member's own listing,
// the steward's received-grant index) and the organization's work list. Pure; absent is said absent.
import { VAULT_RECORD_SCOPE_ENFORCER, decodeVaultRecordScopeTerms } from '@agenticprimitives/delegation';
import type { Hex } from '@agenticprimitives/types';
import type { RosterMember } from '../lib/recipient-directory';

export type ParticipantType = 'person' | 'organization' | 'service' | 'unknown';

export interface RosterRow extends RosterMember {
  type: ParticipantType;
  /** Who admitted them and how: their own signed listing, or the organization's grant on an invitation. */
  sponsor: string;
  /** A responsibility (344) — a role name or a household relation; never a basis for authority. */
  responsibility?: string;
  permissions: string;
  /** Items where this member is an executor (allocated or committed). */
  activeWork: number;
}

export interface RosterInputs {
  members: ReadonlyArray<RosterMember & { admittedVia?: 'listing' | 'invite'; grantCaveats?: Array<{ enforcer: string; terms: string }> }>;
  /** Participants with an allocation or an active commitment, by lowercased address, from the work list. */
  executors: ReadonlyMap<string, number>;
  orgName?: string;
}

const SUFFIX: Record<string, ParticipantType> = {
  me: 'person', impact: 'person', agent: 'person',
  org: 'organization', team: 'organization', church: 'organization', circle: 'organization', household: 'organization',
  svc: 'service', treasury: 'service', workspace: 'service', registry: 'service',
};

export function participantType(publicName: string | null): ParticipantType {
  if (!publicName) return 'unknown';
  const tld = publicName.split('.').pop()?.toLowerCase() ?? '';
  return SUFFIX[tld] ?? 'unknown';
}

/** A record resource in words: `vault:member.profile:0x3b99…` → "the member profile for this organization";
 *  `vault:message.body:*` → "message bodies". An address qualifier names the organization, never the hex. */
function resourceWords(resource: string): string {
  const [key, ...rest] = resource.replace(/^vault:/, '').replace(/:\*$/, '').split(':');
  const label = (key ?? '').replace(/[._-]+/g, ' ');
  if (!rest.length) return label;
  if (/^0x[0-9a-fA-F]{40}$/.test(rest[0] ?? '')) return `the ${label} for this organization`;
  return `${label} ${rest.join(':')}`;
}

/** The record scopes a grant carries, in plain words ("read the organization's profile"). */
export function permissionWords(caveats: ReadonlyArray<{ enforcer: string; terms: string }> | undefined): string {
  if (!caveats?.length) return 'a membership grant — take part; no record scope named';
  const scope = caveats.find((c) => c.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
  if (!scope) return 'a membership grant — take part; no record scope named';
  try {
    const grants = decodeVaultRecordScopeTerms(scope.terms as Hex);
    const words = grants.flatMap((g) => g.resources.map((r) => `${g.ops.join('/')} ${resourceWords(r)}`));
    return words.length ? words.join(' · ') : 'a membership grant — take part';
  } catch { return 'a membership grant (scope unreadable here)'; }
}

export function rosterRows(i: RosterInputs): RosterRow[] {
  return i.members.map((m) => {
    const type = participantType(m.publicName);
    const sponsor = m.admittedVia === 'invite'
      ? `admitted by ${i.orgName ?? 'the organization'} on an invitation (its steward signed the grant)`
      : m.admittedVia === 'listing' ? 'published their own signed listing here' : 'membership recorded; how they were admitted is not in either view';
    const responsibility = [m.kin, m.role && m.role !== 'member' ? m.role : undefined].filter(Boolean).join(' · ') || undefined;
    return {
      ...m, type, sponsor, ...(responsibility ? { responsibility } : {}),
      permissions: m.admittedVia === 'invite' ? permissionWords(m.grantCaveats) : 'their own listing — what they published about themselves; acts still need a mandate',
      activeWork: i.executors.get(m.address.toLowerCase()) ?? 0,
    };
  });
}
