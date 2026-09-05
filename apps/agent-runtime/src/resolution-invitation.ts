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
    'ASK SOMEONE FOR A WAY TO REACH AN AGENT OF THEIRS THAT HAS NO PUBLIC NAME — most often "how do I pay '
    + 'you?". Use this when a payment or message cannot be routed because the thing it should reach is '
    + 'unlisted: it sends the person a request THEY decide on, and if they agree you are given a way to '
    + 'resolve that agent. It moves no money and grants no authority over anything. '
    + 'IT NOTIFIES THEM ITSELF — do NOT also send a direct message; this one step is the whole ask. '
    + 'Args: owner (the person to ask — a name or address), wants (what kind of theirs: "treasury"), '
    + 'purpose (why, in your own words).',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'The person to ask — an agent name (alice.me) or address' },
      wants: { type: 'string', description: "What kind of theirs you need to reach: 'treasury'" },
      purpose: { type: 'string', description: 'Why you are asking, in your own words' },
    },
    required: ['owner'],
  },
  // The request is SENT AS the asker, so it is bounded like any other act of theirs.
  capability: { id: 'resolution.invitation.request', action: 'request', resourceArg: 'owner', authorityArg: 'requester' },
  risk: 'low',
};

/** A grant that has not expired and targets the type being looked for. */
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
