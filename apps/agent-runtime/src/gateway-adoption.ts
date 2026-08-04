// INCREMENTAL GATEWAY ADOPTION — the transition mechanism (ADR-0055 amendment).
//
// The decision this encodes: move `InteractionsDO`'s serving logic onto `PrincipalGatewayDO` one op at a
// time, with the MCP vault UNCHANGED. Not a storage migration (nothing durable moves), and not an
// all-at-once serving-plane swap.
//
// WHY NOT ONE BIG CUTOVER. `InteractionsDO` carries a lot of app-specific behaviour, and even with storage
// held fixed the SERVING logic changes underneath it. Swap it wholesale and a failure could be coming from
// authorization, from the inbox projection, from ordering, from assistant behaviour, or from a data-shape
// difference — five candidates, one symptom, and no way to tell them apart while the app is broken. Moving
// one op at a time does not make the transition safer by being slower; it makes each failure ATTRIBUTABLE,
// which is a different and better property.
//
// THE LADDER. Every op climbs the same three rungs, and never skips one:
//   `off`     — InteractionsDO serves. The gateway is not consulted.
//   `shadow`  — InteractionsDO serves AND ITS ANSWER IS THE RESPONSE. The gateway runs alongside and the
//               two are compared. Divergence is recorded; it never reaches the caller and never fails the
//               request. This is the rung that converts "we think it matches" into evidence.
//   `serving` — the gateway serves. Promotion is earned by a shadow run with no unexplained divergence,
//               not by the code being finished.
//
// WHAT A RUNG DOES NOT DO. Shadowing proves the two planes AGREE; it does not prove either is right. An op
// whose InteractionsDO implementation is wrong will shadow perfectly clean while the gateway faithfully
// reproduces the bug. Promotion is evidence of equivalence, not of correctness — the same reason a
// green migration is not a passing test suite.

/** Which of the five candidate causes an op's move actually exercises. Naming it per op is the point of
 *  moving one at a time: if `inbox.get` diverges, "projection" is where to look, and "auth" is not. */
export type AdoptionConcern = 'auth' | 'projection' | 'ordering' | 'data-shape' | 'assistant';

export type AdoptionStage = 'off' | 'shadow' | 'serving';

export interface AdoptionEntry {
  stage: AdoptionStage;
  /** What moving this op puts at risk — read this first when its shadow diverges. */
  concerns: readonly AdoptionConcern[];
  /** Why this op is at this rung. Kept as prose because "it's next" and "it's blocked" look identical
   *  in a stage field, and the difference is the whole state of the migration. */
  note: string;
  /**
   * Fields that legitimately differ between the two planes because each computes them at its own instant
   * (audit G-4). Declared PER OP and BEFORE evidence arrives — classifying noise after seeing a report is
   * how a real divergence gets explained away as expected.
   *
   * An EMPTY list is a claim, not an omission: it asserts this op has no per-read computation, so any
   * difference is either a race (below) or a defect. Say why in `note` when it is empty.
   */
  volatileFields: readonly string[];
}

/**
 * THE ADOPTION LEDGER — one place that says which plane serves what, so adoption is data rather than
 * conditionals spread across a 4000-line DO. An op absent from this table is `off`: adoption is opt-in,
 * because the failure mode of opt-out is an op that moved because nobody remembered to stop it.
 */
export const GATEWAY_ADOPTION: Readonly<Record<string, AdoptionEntry>> = {
  'inbox.get': {
    stage: 'shadow',
    // Auth: the gateway re-verifies the grant and caches the verdict, where InteractionsDO verifies per
    // call. Projection + data-shape: the gateway returns the co-resident vault tool's envelope, and the
    // inbox document's shape is what the Home replays on every poll. Ordering is NOT in play — this reads
    // one document, it does not fold the exchange stream.
    concerns: ['auth', 'projection', 'data-shape'],
    // NONE, and this is a finding rather than a default. Both planes read the SAME stored vault document
    // and `inboxRevision` is a pure content hash — no clock, no counter, nothing computed per read. So the
    // audit's expected noise source (timestamps, revision counters at different instants) does not exist
    // here. The real one is TEMPORAL: the serving read and the shadow read happen microseconds apart, and
    // a delivery landing in between changes the document legitimately. That is a race, not a volatile
    // field, and a field mask would not have caught it — `raced` classification does.
    volatileFields: [],
    note:
      'first op on the ladder; the exchange stream is untouched, so no ordering claim is being made. ' +
      'BEFORE PROMOTING (audit G-5): the auth concern here is bounded verdict reuse — the gateway caches ' +
      'verdict (A) for VERDICT_TTL_MS (60s) where InteractionsDO verifies per call, so a revoked ' +
      'delegation can pass admission for up to that window. demo-mcp re-enforces per record and is the ' +
      'authority, which bounds the exposure to admission only — but it is a real behaviour change and it ' +
      'must be stated, not discovered. ' +
      'NOISE MODEL (audit G-4): no volatile fields — both planes read the same stored document and ' +
      'inboxRevision is a pure content hash. The only benign difference is a RACE (a delivery landing ' +
      'between the two reads), which the re-read classifies as `raced` rather than leaving it to look ' +
      'like a defect.',
  },
};

/**
 * The stage this op runs at IN THIS DEPLOYMENT.
 *
 * The ledger says how far an op has climbed in the code; `GATEWAY_SHADOW` says whether this deployment is
 * running the comparison at all. Both are required, and the env one defaults to OFF.
 *
 * WHY, CONCRETELY. Constructing the gateway runs the `CREATE TABLE IF NOT EXISTS` of every store it owns.
 * The probe op made those tables appear only for a principal who explicitly called it. The SHADOW hangs off
 * `inbox.get` — which every principal polls — so shipping it ungated would create those tables in
 * essentially every InteractionsDO in the deployment, as a side effect of a commit landing. They are empty
 * and harmless, and that is beside the point: the previous commit's claim was that adopting the gateway
 * would not change anyone's storage until someone decided it should, and an ungated shadow quietly makes
 * the decision for every principal at once.
 *
 * Empty string is unset, not enabled — `wrangler`'s `VAR = ""` binds an empty string that `??` sails
 * straight past.
 */
export function adoptionStage(op: string, env?: { GATEWAY_SHADOW?: string }): AdoptionStage {
  const stage = GATEWAY_ADOPTION[op]?.stage ?? 'off';
  if (stage === 'shadow' && (env?.GATEWAY_SHADOW ?? '').trim().toLowerCase() !== 'on') return 'off';
  return stage;
}

// ── Divergence ────────────────────────────────────────────────────────────────────────────────────────

export interface Divergence {
  op: string;
  at: string;
  /** `equal` is recorded too. A shadow that only reports differences cannot distinguish "the planes agree"
   *  from "the shadow never ran", and those justify opposite decisions about promoting. */
  kind: 'equal' | 'value' | 'raced' | 'gateway-error' | 'shadow-skipped';
  detail?: string;
}

/**
 * Compare the two planes' answers.
 *
 * Canonical-JSON with sorted keys: key ORDER is not a difference worth blocking a promotion on, and a
 * comparison that flagged it would drown the real signal in noise on its first run. Everything else counts,
 * including `undefined` vs absent — a field that vanished is exactly the data-shape drift being watched for.
 */
export function compareServed(op: string, served: unknown, shadow: unknown, at: string): Divergence {
  const a = canonical(served);
  const b = canonical(shadow);
  if (a === b) return { op, at, kind: 'equal' };
  return { op, at, kind: 'value', detail: firstDifference(a, b) };
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : val,
  ) ?? 'undefined';
}

/** A bounded excerpt around the first difference. Bounded because a divergence report that embeds two
 *  whole inbox documents is a copy of the person's mail in a diagnostic buffer — the precise thing the
 *  vault doctrine exists to prevent, arrived at through the back door. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const w = 40;
  return `@${i}: served=${JSON.stringify(a.slice(Math.max(0, i - 8), i + w))} shadow=${JSON.stringify(b.slice(Math.max(0, i - 8), i + w))}`;
}

/**
 * Was an apparent divergence just the document moving between the two reads?
 *
 * THE NOISE SOURCE THAT ACTUALLY EXISTS on `inbox.get`. The serving read happens, then the shadow read
 * happens; a delivery landing in between changes the document, and the two planes then honestly report
 * different things about different instants. Left unclassified, every busy principal generates `value`
 * divergences that mean nothing — and a report full of benign differences is worse than no report,
 * because the mechanism loses credibility exactly when it is about to be trusted for a promotion.
 *
 * The check: after the shadow read, take the serving read AGAIN.
 *   · `servedAgain` matches the shadow  ⇒ the document moved. RACED — benign, and evidence of nothing.
 *   · `servedAgain` still matches the original, and differs from the shadow ⇒ the planes really disagree.
 *
 * Costs one extra vault read per SAMPLED shadow (at most one per principal per minute), which is the
 * price of the difference between evidence and noise.
 *
 * DELIBERATELY CONSERVATIVE: anything that is not provably a race stays `value`. A classifier that
 * guessed "probably a race" would suppress the exact signal the whole rung exists to collect.
 */
export function classifyDivergence(input: {
  op: string;
  served: unknown;
  shadow: unknown;
  servedAgain: unknown;
  at: string;
}): Divergence {
  const first = compareServed(input.op, input.served, input.shadow, input.at);
  if (first.kind === 'equal') return first;
  const settled = compareServed(input.op, input.servedAgain, input.shadow, input.at);
  if (settled.kind === 'equal') {
    return { op: input.op, at: input.at, kind: 'raced', detail: 'document changed between the serving read and the shadow read' };
  }
  return first;
}

// ── Sampling ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Should this call run its shadow?
 *
 * SHADOWING IS NOT FREE, AND `inbox.get` IS THE HOTTEST PATH IN THE APP — the Home polls it every 5s per
 * open tab. Shadowing every call DOUBLES the delegated vault reads on exactly the path that has already
 * hit demo-mcp's stage-2 limiter (120 verified calls/60s per principal+capability), whose rejection once
 * surfaced to members as a raw "auth failed". A comparison harness that takes the app down to gather
 * evidence has misunderstood which of the two matters.
 *
 * So: sampled, and cheap to reason about — at most one shadow per principal per `intervalMs`. Time-based
 * rather than 1-in-N because it bounds the ADDED LOAD directly, which is the thing that hurts; a ratio
 * bounds a proportion of a rate that itself varies with how many tabs someone has open.
 */
export function shouldShadow(input: {
  lastShadowAt: number | undefined;
  now: number;
  intervalMs: number;
}): boolean {
  if (input.lastShadowAt === undefined) return true; // the first call always samples — otherwise a
  // low-traffic principal could go a whole deploy without contributing a single observation.
  return input.now - input.lastShadowAt >= input.intervalMs;
}

/** One shadow per principal per minute. Enough to catch a systematic difference within a session; far
 *  below the limiter's budget even with several tabs open. */
export const SHADOW_INTERVAL_MS = 60_000;

/** How many divergences to keep. In MEMORY, not DO storage: these are diagnostics with a shelf life of one
 *  investigation, and writing them durably would put a bounded copy of message metadata on disk in service
 *  of a temporary question. Losing them on isolate recycle is the correct trade. */
export const DIVERGENCE_BUFFER = 20;

export function recordDivergence(buf: Divergence[], d: Divergence): Divergence[] {
  buf.push(d);
  return buf.length > DIVERGENCE_BUFFER ? buf.slice(-DIVERGENCE_BUFFER) : buf;
}
