// ASKING SOMEONE HOW TO PAY THEM — spec 338 / ADR-0056, made conversational.
//
// THE SITUATION. Alice keeps a treasury with no name. That is a real choice, not an omission: an unnamed
// agent is absent from the naming service, absent from the public directory, and (spec 355 W2) absent
// from the on-chain ownership edges, because recording "alice holds a treasury at 0x…" would put back
// exactly the fact the missing name withholds. So Nathan cannot find it, and should not be able to.
//
// What he CAN do is ask her. She decides, in her own Home, whether to tell him — and what she gives him
// is a RESOLUTION GRANT: permission to DISCOVER where to send money, never permission to move any. That
// distinction is the whole of ADR-0056 and it is worth restating at every layer, because the two are
// easy to conflate and disastrous to conflate: after this grant Nathan knows an address, and he still
// cannot spend a cent of hers. His own treasury's mandate is what pays.
//
// WHY IT RIDES MESSAGING. The request and the grant are both things one person sends another, and the
// messaging rail already delivers into the recipient's vault under their own authority. A new transport
// would be a second delivery path to secure. The typed body is what makes it a request rather than prose.
import type { ToolSpec } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';

/** The record family a person's held grants and pending requests live in, in their own vault. */
export const RESOLUTION_REQUESTS_RECORD = 'resolution.requests';
export const RESOLUTION_GRANTS_RECORD = 'resolution.grants';
/** The requester's own record of asks they are waiting on. Rides the same scope as the requests they
 *  receive: one record family for "resolution requests", whichever end of one you are. */
export const RESOLUTION_SENT_RECORD = 'resolution.requests';

/** What Nathan sends Alice. Deliberately small: it names what he wants to reach and why, and nothing else. */
export interface ResolutionInvitationRequestV1 {
  v: 1;
  kind: 'resolution.invitation.request';
  /** Who is asking. The recipient's Home shows this and decides. */
  requester: Address;
  /** The agent whose records hold the thing he wants to reach — the person, not the hidden agent. */
  owner: Address;
  /** What KIND of theirs he is asking to reach, as an ontology-backed suffix ('treasury'). */
  wants: string;
  /** Why, in the requester's own words. A person approving deserves the reason unedited. */
  purpose: string;
  /** What the requester was trying to send when routing failed, in whole USDC. Recorded so the payment
   *  can be finished in one press when the answer comes back — and so the person deciding can see the
   *  size of what they are enabling. Absent when the ask named no figure. */
  amount?: string;
  requestedAt: string;
}

/** The requester's OWN record of an ask they are waiting on. Their Home joins it to a delivered grant
 *  to offer "you can finish this now" — the half that turns a granted address into a completed payment. */
export interface SentResolutionRequestV1 {
  v: 1;
  kind: 'resolution.invitation.sent';
  owner: Address;
  ownerName?: string;
  wants: string;
  amount?: string;
  requestedAt: string;
}

/** What Alice hands back — the grant plus the words a surface needs to show it. */
export interface HeldResolutionGrantV1 {
  v: 1;
  kind: 'resolution.grant.held';
  /** The opaque grant id — never name-derived (spec 338 §4). */
  grantId: string;
  /** The agent this permits DISCOVERING. Knowing it is not permission to use it. */
  targetAgent: Address;
  /** Whose agent it is, so a surface can say "alice's treasury" without a name for the treasury. */
  owner: Address;
  ownerName?: string;
  /** The type of the target, so a party resolver can match it to what a capability wants. */
  targetType: string;
  /** A label the OWNER chose for this grant, if any. Never the target's name — it has none. */
  label?: string;
  issuedAt: string;
  expiresAt: string;
  /** The full grant as issued, kept verbatim so it can be presented and re-checked. */
  grant: unknown;
}

export const RESOLUTION_REQUEST_TOOL: ToolSpec = {
  id: 'resolution.invitation.request',
  description:
    'ASK SOMEONE FOR A WAY TO REACH AN AGENT OF THEIRS THAT HAS NO PUBLIC NAME. '
    + 'NEVER THE FIRST STEP FOR A PAYMENT OR A MESSAGE: if the ask is to send money or write to someone, '
    + 'choose the capability that DOES that — it resolves who is meant and asks for whatever it needs. '
    + 'This one is for the case where that has already failed because the thing to reach is unlisted, or '
    + 'where the person explicitly asks for an introduction, an invitation, or a way to reach something. '
    + 'It sends the owner a request THEY decide on; if they agree you are given a way to resolve that '
    + 'agent. It moves no money and grants no authority over anything. '
    + 'IT NOTIFIES THEM ITSELF — do NOT also send a direct message; this one step is the whole ask. '
    + 'Args: owner (the person to ask — a name or address), wants (what kind of theirs: "treasury"), '
    + 'purpose (why, in your own words).',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'The person to ask — an agent name (alice.me) or address' },
      wants: { type: 'string', description: "What kind of theirs you need to reach: 'treasury'" },
      purpose: { type: 'string', description: 'Why you are asking, in your own words' },
      usdc: { type: 'string', description: 'The amount you were trying to send, in whole USDC, when the ask named one. Pass it so the payment can be finished in one step later.' },
    },
    required: ['owner'],
  },
  // The request is SENT AS the asker, so it is bounded like any other act of theirs.
  capability: { id: 'resolution.invitation.request', action: 'request', resourceArg: 'owner', authorityArg: 'requester' },
  risk: 'low',
};

/** A grant of the right type that has not expired. SHAPE ONLY — see `verifiedGrants` for the rest. */
export function usableGrants(held: unknown, type: string, now = Date.now()): HeldResolutionGrantV1[] {
  const rows = Array.isArray((held as { grants?: unknown[] } | null)?.grants)
    ? ((held as { grants: unknown[] }).grants as HeldResolutionGrantV1[])
    : [];
  return rows.filter((g) => {
    if (!g || g.kind !== 'resolution.grant.held') return false;
    if (g.targetType !== type) return false;
    // An expired grant is not a weaker grant, it is not a grant. The owner set the window.
    return !g.expiresAt || Date.parse(g.expiresAt) > now;
  });
}

/**
 * THE GRANTS THIS PERSON CAN ACTUALLY USE — checked, not merely held.
 *
 * The record lives in the HOLDER'S OWN VAULT, which the holder can write. So the record is not the
 * evidence: the signed grant inside it is. Without this check, "I hold a grant from Alice" was a
 * sentence anyone could write about themselves, and the privacy of an unlisted agent rested entirely on
 * its address not being in any public place — true, and not the same as being enforced.
 *
 * Three things are checked and each rules out a different forgery:
 *   · the ISSUER signed this exact grant (ERC-1271, re-derived from the canonical body) — so a
 *     self-written record naming someone else's treasury is refused;
 *   · the grant names THIS asker as its subject — it is recipient-bound (spec 338 §4), so one person's
 *     grant passed to another does not work;
 *   · the target it permits is the target being reached — so a valid grant cannot be re-pointed;
 *   · the issuer has not WITHDRAWN it (see `revokedBy`).
 *
 */
export async function verifiedGrants(
  held: unknown,
  type: string,
  ctx: {
    asker: string;
    chainId: number;
    /** ERC-1271 / ECDSA signature check, as the mandate path does it. */
    verifySignature: (input: { signer: string; digest: string; signature: string }) => Promise<boolean>;
    /** Canonical bytes of the grant as signed. */
    digestOf: (grant: unknown) => string;
    /** The grant ids this issuer has withdrawn, read from THEIR record. Absent ⇒ revocation unchecked. */
    revokedBy?: (issuer: string) => Promise<string[]>;
    now?: number;
  },
): Promise<HeldResolutionGrantV1[]> {
  const caip = (a: string) => `eip155:${ctx.chainId}:${a.toLowerCase()}`;
  const out: HeldResolutionGrantV1[] = [];
  for (const held1 of usableGrants(held, type, ctx.now)) {
    const g = held1.grant as { issuer?: string; subject?: string; targetAgent?: string; proof?: { signature?: string } } | undefined;
    if (!g?.proof?.signature) continue;
    if (String(g.subject ?? '').toLowerCase() !== caip(ctx.asker)) continue;
    if (String(g.targetAgent ?? '').toLowerCase() !== caip(held1.targetAgent)) continue;
    const issuer = String(g.issuer ?? '').match(/0x[0-9a-fA-F]{40}$/)?.[0];
    if (!issuer || issuer.toLowerCase() !== held1.owner.toLowerCase()) continue;
    const ok = await ctx.verifySignature({ signer: issuer, digest: ctx.digestOf(g), signature: g.proof.signature }).catch(() => false);
    if (!ok) continue;
    // WITHDRAWN IS NOT WEAKER, IT IS OVER. Checked against the issuer's own status, which is the only
    // side that can say — the holder keeps the record either way. A status that cannot be READ refuses:
    // the point of revocation is that someone changed their mind, and "I could not ask" is exactly the
    // case where that matters most.
    if (ctx.revokedBy) {
      const revoked = await ctx.revokedBy(issuer).catch(() => null);
      if (revoked === null || revoked.includes(held1.grantId)) continue;
    }
    out.push(held1);
  }
  return out;
}
