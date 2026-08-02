// Recipient-side invitation verification (spec 338 §5 / §20, W6).
//
// Pure and React-free so it is testable and reusable (a server route could run the identical checks).
// The component only renders what this returns.
//
// ─── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────────────────────────
// PROVES: the invitation is internally consistent (the grant targets the agent the invitation names,
// the expected binding agrees, the recipient matches), it has not expired, and the carried
// publication's DIGEST recomputes — so the service details were not altered after signing.
//
// DOES NOT PROVE: who signed. That requires an on-chain ERC-1271 read this module deliberately does
// not perform. A digest match is tamper-evidence, not authorship. The UI must render that difference
// rather than showing a single green tick.

import {
  checkFreshness,
  digestOf,
  publicationBody,
  validateInvitationShape,
  type AgentConnectionInvitationV1,
} from '@agenticprimitives/agent-resolution';

export type CheckState = 'pass' | 'fail' | 'unchecked';

export interface InvitationCheck {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
}

export interface InvitationInspection {
  invitation: AgentConnectionInvitationV1;
  checks: InvitationCheck[];
  /** True when any check failed — the caller must tell the user not to connect. */
  failed: boolean;
}

export class InvitationParseError extends Error {}

/**
 * Inspect a pasted invitation.
 *
 * Throws only for input that is not an invitation at all; every substantive problem is reported as a
 * FAILED CHECK rather than an exception, so a recipient sees which part is wrong instead of one
 * opaque error.
 */
export async function inspectInvitation(
  raw: string,
  now: () => Date = () => new Date(),
): Promise<InvitationInspection> {
  let parsed: AgentConnectionInvitationV1;
  try {
    parsed = JSON.parse(raw) as AgentConnectionInvitationV1;
  } catch {
    throw new InvitationParseError('That is not valid JSON.');
  }
  if (parsed?.specVersion !== 'ap.agent-connection-invitation/1') {
    throw new InvitationParseError('This is not an agent connection invitation.');
  }

  const checks: InvitationCheck[] = [];
  const nowDate = now();

  const shape = validateInvitationShape(parsed);
  checks.push({
    id: 'shape',
    label: 'Invitation is internally consistent',
    state: shape.length === 0 ? 'pass' : 'fail',
    detail: shape.map((v) => v.message).join('; ') || undefined,
  });

  const expiresAt = Date.parse(parsed.expiresAt);
  const expired = Number.isNaN(expiresAt) || expiresAt <= nowDate.getTime();
  checks.push({
    id: 'expiry',
    label: 'Invitation has not expired',
    state: expired ? 'fail' : 'pass',
    detail: Number.isNaN(expiresAt) ? 'unreadable expiry' : `expires ${new Date(expiresAt).toISOString()}`,
  });

  const pub = parsed.initialPublication;
  if (!pub) {
    checks.push({
      id: 'publication',
      label: 'Carries initial service details',
      state: 'fail',
      detail: 'No service details attached — you would have to look this agent up before connecting.',
    });
    return { invitation: parsed, checks, failed: true };
  }

  // Digest: recomputed from the canonical body, so ANY altered field is caught — including one the
  // sender changed after the target signed.
  const { digest: _d, proofs: _p, ...body } = pub;
  const recomputed = await digestOf(publicationBody(body as never));
  const digestOk = recomputed === pub.digest;
  checks.push({
    id: 'digest',
    label: 'Service details are unaltered since signing',
    state: digestOk ? 'pass' : 'fail',
    detail: digestOk ? undefined : 'digest mismatch — do not connect',
  });

  const fresh = checkFreshness({
    channelId: pub.channelId,
    sequence: pub.sequence,
    previousDigest: pub.previousDigest,
    digest: pub.digest,
    issuedAt: pub.issuedAt,
    notBefore: pub.notBefore,
    expiresAt: pub.expiresAt,
    now: nowDate.toISOString(),
  });
  checks.push({
    id: 'freshness',
    label: 'Service details are still fresh',
    state: fresh.fresh ? 'pass' : 'fail',
    detail: fresh.fresh
      ? `version #${pub.sequence.toString()}, fresh for ${Math.max(0, Math.round(fresh.remainingMs / 60000))} more minutes`
      : fresh.failures.map((f) => f.message).join('; '),
  });

  checks.push({
    id: 'status',
    label: 'Service details are active',
    state: pub.status === 'active' ? 'pass' : 'fail',
    detail: pub.status === 'active' ? undefined : `status: ${pub.status}`,
  });

  // The honest gaps — rendered as `unchecked`, never as a pass.
  checks.push({
    id: 'signature',
    label: 'Signature verified on-chain',
    state: 'unchecked',
    detail: 'Needs an on-chain read. A digest match proves the details were not altered — not who signed them.',
  });

  const hasEndpointProof = pub.surfaces.some((s) => s.endpointControlProof);
  checks.push({
    id: 'endpoint-control',
    label: 'Endpoint control proven',
    state: hasEndpointProof ? 'unchecked' : 'fail',
    detail: hasEndpointProof
      ? 'A proof is attached; it is verified by the connecting agent, not here.'
      : 'No endpoint-control proof — the publisher has not proven it controls this address.',
  });

  return { invitation: parsed, checks, failed: checks.some((c) => c.state === 'fail') };
}

/**
 * The sentence a recipient must read (spec 338 §20).
 *
 * Kept next to the checks so it cannot be dropped from a redesign: a successful verification is
 * routinely misread as "I now have access", which is the exact error ADR-0056 exists to prevent.
 */
export const AUTHORIZATION_NOT_GRANTED =
  'This invitation only tells you how to reach the agent. Every call will still be refused until its owner grants you a separate, revocable permission — and either one can be withdrawn without the other.';
