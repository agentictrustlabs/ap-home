// POST /connect/org-decide { org, applicant, applicationId?, decision, reason?, memberAccessDelegation? }
// spec 324 §7 — the steward's EnrollmentDecision on a MembershipApplication. Steward-gated (controlsOrg).
//
// Membership is written SELF-gated by the MEMBER (W3), so a decision never creates the applicant's membership
// directly. Instead approval mirrors the invite tail: store the client-pre-signed org→applicant member-access
// grant (so `recordOrgMembership` picks it up when the applicant completes the join) + send an "approved"
// message carrying the Join chip; the APPLICANT then joins via the existing path. Reject sends a decline. The
// decision message confers NOTHING (ADR-0041/0048 #8). actor(decidedBy) ≠ principal(org) is preserved in the
// EnrollmentDecision record.
import type { FnContext } from '../_lib/server-broker';
import type { Address, CanonicalAgentId } from '@agenticprimitives/types';
import { buildEnrollmentDecision } from '@agenticprimitives/organization';
import { controlsOrg } from './org-invite';
import { orgVault } from '../lib/org-vault';
import type { OrgApplication } from '../lib/org-applications';
import { CHAIN_ID } from '../../src/lib/chain';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);
const caip10 = (a: string): CanonicalAgentId => `eip155:${CHAIN_ID}:${a}` as CanonicalAgentId;

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | {
        org?: string;
        applicant?: string;
        applicationId?: string;
        decision?: 'approve' | 'reject';
        reason?: string;
        memberAccessDelegation?: { delegator?: string; delegate?: string; signature?: string };
      }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  const applicant = (body?.applicant ?? '').toLowerCase();
  const decision = body?.decision;
  if (!isAddress(org) || !isAddress(applicant)) return json({ error: 'org + applicant (SAs) required' }, 400);
  if (decision !== 'approve' && decision !== 'reject') return json({ error: 'decision must be approve|reject' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to decide applications' }, 403);

  // The signed decision RECORD (spec §7). decidedByAgent == org here (a delegated decider would differ; the
  // shape carries actor≠principal). Approval CREATES no authority on its own — it authorizes the issuance tail.
  const enrollmentDecision = buildEnrollmentDecision({
    decisionId: `dec_${body?.applicationId ?? Date.now()}`,
    organizationAgent: caip10(org),
    decidedByAgent: caip10(org),
    decision,
    decidedAt: new Date().toISOString(),
    ...(body?.applicationId ? { applicationId: body.applicationId } : {}),
    ...(body?.reason ? { reason: body.reason } : {}),
  });


  if (decision === 'approve') {
    // Store the client-pre-signed org→applicant member-access grant (same shape as the invite path), so the
    // applicant's join picks it up. Best-effort: a missing/invalid grant still approves — the org can re-grant.
    const mad = body?.memberAccessDelegation;
    if (mad?.signature && (mad.delegator ?? '').toLowerCase() === org && (mad.delegate ?? '').toLowerCase() === applicant) {
      const vault = await orgVault(env, org).catch(() => null);
      if (vault) await vault.set(`org.invite:agent:${applicant}`, { delegation: mad, createdAt: Date.now(), status: 'pending' }).catch(() => {});
    }
  }
  // THE DECISION NOTICE IS NOT SENT HERE (spec 341 §5.1c). It used to be: this route wrote the message
  // straight into the applicant's vault as the org, over a standing grant and a shared secret. Sending
  // as an organization now means presenting its stewardship delegation and its messaging wire, and the
  // party that holds both is the STEWARD'S BROWSER — which is where the notice is sent from, right
  // after this call returns. The decision itself stands either way; a notice is never authority
  // (ADR-0041), and the Join chip it carries confers nothing the member-access grant above did not.

  // The queue cleanup moved to the steward's browser (spec 341 §5.3), with the same stewardship
  // delegation that authorizes reading it. It used to happen here over the shared-secret bridge, where
  // the secret proved the caller was our Home and nothing about whether this person may act for this
  // organization — a separate `controlsOrg` check against a Home-local projection carried that, which
  // is a different fact in a different place from the authority itself.

  return json({ ok: true, decision: enrollmentDecision });
};
