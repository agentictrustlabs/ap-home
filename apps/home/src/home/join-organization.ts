// JOINING AN ORGANIZATION — one ceremony, whatever asked for it. The Join button (OrgDiscussionsView) and the Ask ("accept the
// invitation to Missio Nexus", spec 421: the agent's `organization.membership.accept` step asks the Home to run it) both call
// THIS, so the Ask does exactly what the button does (the rule: one capability model → every surface).
//
// What it does, in order: publish the member's listing into the organization's directory (signed by the member); enable
// the member's own interactions plane when that costs no extra device prompt (KMS homes sign server-side); record the
// membership — the member→organization delegation, her consent for herself only, and the countersigned credential
// (`recordOrgMembership`); provision the community's messaging. Nothing here signs for anyone but the member.
import type { Address } from '@agenticprimitives/types';
import { issueDirectoryListing } from './directory';
import { activateInteractionsIfNeeded, isKmsVia, resolveVia, signHashFor, type Via } from './onboarding';
import { recordOrgMembership } from '../lib/org-membership';
import { provisionCommunityMessaging } from '../lib/messaging-ceremony';

export interface JoinOrganizationInput {
  member: Address;
  org: string;
  /** The name the organization's roster shows (her naming-service name by default). */
  displayName: string;
  session: { token: string; via?: Via | string };
  /** The home's recorded credential (routes the signer: a KMS home never pops a passkey or wallet). */
  credential?: unknown;
  /** Whether the member has a naming-service name (messaging provisioning uses it). */
  named: boolean;
}

export async function joinOrganization(input: JoinOrganizationInput): Promise<void> {
  const org = input.org.toLowerCase();
  const via = resolveVia(input.credential as never, input.session.via as never);
  const sign = await signHashFor(via, input.member, { token: input.session.token });
  const listing = await issueDirectoryListing(input.member, sign, { communityId: org, displayName: input.displayName });
  const res = await fetch('/connect/directory', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${input.session.token}` },
    body: JSON.stringify({ action: 'publish', listing }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `join failed (${res.status})`);
  // spec 322 W3d — the member's own interactions plane, when it costs no extra device prompt.
  if (isKmsVia(via)) await activateInteractionsIfNeeded(input.member, via, { token: input.session.token }).catch(() => null);
  // spec 321 W1/W2b — the membership delegation (member→org); the server attaches any steward-pre-signed grant.
  await recordOrgMembership(input.member, org, sign, input.session.token, null, input.displayName);
  await provisionCommunityMessaging({ person: input.member, org: org as Address, named: input.named, via, token: input.session.token })
    .catch((e) => { console.warn('[join] community messaging provision failed (non-fatal):', e); });
}
