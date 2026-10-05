import type { AdapterDeclarationV1, ToolSpec } from '@agenticprimitives/orchestration';
import { PAYLOAD_CLASS } from '@agenticprimitives/ontology';

// Spec 410 §2 — WHAT EACH BUILT-IN ADAPTER DECLARES. Facts about the adapter, stated by the app that owns it, never
// inferred from a response. `verificationWindow` is the time between the harness's check and the provider's
// commit; `retry` what a second identical call does (the on-chain nonce and the operation ledgers make the
// families below idempotent by key); `cancellation` what a cancel can do — `none` keeps the word out of every
// projection of that tool.
export const ADAPTER: Record<'chain' | 'sync' | 'external' | 'unknown', AdapterDeclarationV1> = {
  /** A userOp the bundler client waits on: one block between the check and the commit; a mined tx cannot be cancelled. */
  chain: { verificationWindow: 'PT15S', retry: 'idempotent-by-key', cancellation: 'none' },
  /** The sender's or the person's own object, synchronous: delivered-or-refused, recorded-or-refused. */
  sync: { verificationWindow: 'PT0S', retry: 'idempotent-by-key', cancellation: 'none' },
  /** An outside provider that answers synchronously and keeps what it made (a PR, an event, a sent mail). */
  external: { verificationWindow: 'PT0S', retry: 'never', cancellation: 'none' },
  /** An outside MCP server nobody here vouches for: the window is whatever it is, and a second call is a second call. */
  unknown: { verificationWindow: 'unbounded', retry: 'never', cancellation: 'none' },
};

// Spec 410 §7 — WHAT EACH BUILT-IN'S WRITE CARRIES, per argument, as payload classes (`tbox/payload.ttl`). The adapter
// author's claim about the argument's KIND, never an inspection of its value: a free-text body is `FreeText` whatever
// the person typed into it. A mandate's payload-classes caveat permits a set; the verifier compares (an undeclared
// payload is denied under any caveat, which is why text arguments are declared rather than left out). Estates without
// the enforcer (generation < 3) mint no caveat: `carries` is stripped from the requirement there (harness-run).
const T = PAYLOAD_CLASS;
export const CARRIES = {
  /** A message body: the person's words, or a body composed for them. */
  message: { message: [T.FreeText] },
  /** A payment: value moves; the memo is words. */
  payment: { usdc: [T.Money], memo: [T.FreeText] },
  /** An invitation's terms: kinship and role words; the invitee is a party, not a payload. */
  membership: { kin: [T.MembershipTerms], role: [T.MembershipTerms] },
  /** A member's role in an organization (spec 427): the role offer — a definition id, words, registry references. */
  memberRole: { role: [T.MembershipTerms] },
  /** A contact invitation's role word. */
  contact: { role: [T.MembershipTerms] },
  /** A standing instruction: the default an argument will take from now on. */
  instruction: { value: [T.Instruction] },
  /** A routine: the sentence, clock and all, that will run. */
  routine: { sentence: [T.Instruction] },
  /** A remembered fact about the person, in their words. */
  memory: { fact: [T.PersonalPreference] },
  /** Answer preferences. */
  preferences: { style: [T.PersonalPreference], language: [T.PersonalPreference], callMe: [T.PersonalPreference], emailNudges: [T.PersonalPreference], routineEmails: [T.PersonalPreference] },
  /** A calendar entry: when, where, what. */
  event: { summary: [T.EventDetails], start: [T.EventDetails], end: [T.EventDetails], location: [T.EventDetails], description: [T.FreeText] },
  /** Mail: addresses leave with it; the body is words. */
  mail: { to: [T.ContactEmail], cc: [T.ContactEmail], subject: [T.FreeText], body: [T.FreeText] },
  /** A pull request: its words and its files. */
  prOpen: { title: [T.FreeText], body: [T.FreeText], files: [T.CodeChange] },
  /** A review comment: words on a PR. */
  prComment: { body: [T.FreeText] },
  /** A build task: the words the model turns into files (the files land in the vault, not outside). */
  build: { task: [T.FreeText] },
  /** A coordination request: the goal in the person's words. */
  coordination: { goal: [T.FreeText] },
} as const satisfies Record<string, NonNullable<ToolSpec['carries']>>;
