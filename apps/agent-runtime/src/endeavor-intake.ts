// spec 334 §4 — ONE ENGINE, FOUR DOORS (W4). Every surface that can raise coordination work builds
// the SAME `endeavor.request` op body; the door sets `entryPoint` + `intakeContext` provenance,
// never a different model. These adapters are pure body builders from each surface's native
// objects; the op itself still runs through `handleEndeavorOp` → `SubmitEndeavorRequest` →
// the reducer (the only mutation path, spec 332 §9).
//
// Door 1 (home-request) is the Home composer posting `endeavor.request` directly (W3, live).
// Door 4 (a2a-intent) is wired LIVE here via the orchestrate skill (see ./a2a-task-do.ts):
// an inbound A2A intent task whose input opts in (`input.endeavor === true`) is admitted as an
// EndeavorRequest against the managing principal, requester = the delegation-verified task
// sender. Doors 2 (discussion-ask) and 3 (inbox-ask) ship as adapters: their live triggers are
// the spec-327/328 assistant turns, and auto-filing from message text would violate spec 334 §3
// rule 2d (a coordination event is never inferred from prose) without a UX affordance — out of
// W4 scope.
//
// This module also owns the EXECUTION BINDING (spec 334 §4 door 4, reverse direction / spec 332
// §10): when a committed PlanStep executes as an A2A task, the task input carries the
// adapter-contract provenance keys so `projectEndeavorProvenance` can join the run to
// `p-plan:correspondsToStep`. The keys are PROVENANCE, never authority (spec 332 §9 rule 1) —
// the task's delegation gate is untouched by their presence.
import type { ExecutionIntentDescriptorV1, ExecutionProvenanceKeysV1 } from '@agenticprimitives/coordination';

/** The `endeavor.request` op body every door produces (spec 334 §3). */
export interface EndeavorRequestOpBody {
  goal: string;
  entryPoint: 'home-request' | 'discussion-ask' | 'inbox-ask' | 'a2a-intent';
  intakeContext: Array<{ kind: string; id: string }>;
}

/** Door 2 — a discussion `@ask` (spec 329 / 327): the topic + triggering message become the intake context. */
export function endeavorRequestFromDiscussionAsk(args: {
  channelId: string;
  messageId: string;
  question: string;
}): EndeavorRequestOpBody {
  return {
    goal: args.question.trim(),
    entryPoint: 'discussion-ask',
    intakeContext: [
      { kind: 'channel-message', id: args.messageId },
      { kind: 'channel', id: args.channelId },
    ],
  };
}

/** Door 3 — a 1:1 inbox agent ask (spec 328): the envelope is the intake context. */
export function endeavorRequestFromInboxAsk(args: {
  conversationId: string;
  messageId: string;
  ask: string;
}): EndeavorRequestOpBody {
  return {
    goal: args.ask.trim(),
    entryPoint: 'inbox-ask',
    intakeContext: [
      { kind: 'inbox-message', id: args.messageId },
      { kind: 'conversation', id: args.conversationId },
    ],
  };
}

/**
 * The A2A skill name door 4 answers to, and the selector the Operational Intent grant
 * (`org → agent`) is minted against. The gate authorizes a message by the skill it NAMES, so this
 * string IS the authority boundary: `skillSelector('endeavor.request')` must equal the
 * `allowedMethods` entry the minting side encoded.
 *
 * Kept as a local literal on both sides — the `CONSULT_SKILL` precedent: demo-sso-next's
 * `OPERATIONAL_INTENT_SKILLS` (`src/lib/delegation.ts`) is a transport-agnostic module that takes no
 * dependency on this app, and this app takes none on the Home. CHANGING EITHER STRING SILENTLY
 * BREAKS EVERY MINTED GRANT — the selector stops matching and the gate refuses a credential that
 * looks correct. Change both, or neither.
 */
export const ENDEAVOR_REQUEST_SKILL_ID = 'endeavor.request' as const;

/**
 * The READ side of the same grant: follow an intent you submitted. Selector `0x4ddc81aa`, already
 * named by `OPERATIONAL_INTENT_SKILLS` — so a grant minted before this handler existed reaches it
 * the moment it ships, with no re-mint. Same drift rule as above: change this string and every
 * minted grant stops matching.
 */
export const ENDEAVOR_STATE_SKILL_ID = 'endeavor.state' as const;

/** Fail-closed parse of an `endeavor.state` body: an endeavor id and nothing else. */
export function parseEndeavorStateInput(
  input: unknown,
): { ok: true; endeavorId: string } | { ok: false; error: string } {
  const raw = input as { endeavorId?: unknown } | string | null;
  const id = (typeof raw === 'string' ? raw : typeof raw?.endeavorId === 'string' ? raw.endeavorId : '').trim();
  if (!id.startsWith('end_')) return { ok: false, error: 'endeavor.state requires input.endeavorId (an end_… id)' };
  return { ok: true, endeavorId: id };
}

/**
 * Fail-closed parse of an `endeavor.request` message body. The skill accepts a bare goal string or
 * `{ goal }` — and NOTHING ELSE. A body carrying `entryPoint` or `intakeContext` is REFUSED rather
 * than sanitized: those are the door's provenance to set (spec 334 §4), so a caller supplying them
 * is asserting which door raised the work. Silently dropping a forgery attempt still leaves a
 * caller who believes it worked (ADR-0013 — no silent skip).
 */
export function parseEndeavorRequestInput(
  input: unknown,
): { ok: true; goal: string } | { ok: false; error: string } {
  const raw = input as { goal?: unknown; entryPoint?: unknown; intakeContext?: unknown } | string | null;
  if (typeof raw === 'object' && raw !== null && (raw.entryPoint !== undefined || raw.intakeContext !== undefined)) {
    return { ok: false, error: 'endeavor.request sets entryPoint/intakeContext itself — remove them from the body' };
  }
  const goal = (typeof raw === 'string' ? raw : typeof raw?.goal === 'string' ? raw.goal : '').trim();
  if (!goal) return { ok: false, error: 'endeavor.request requires input.goal (a declarative goal)' };
  return { ok: true, goal };
}

/** Door 4 — an inbound A2A intent task: the task ref is the intake context. */
export function endeavorRequestFromA2aTask(args: { taskId: string; goal: string }): EndeavorRequestOpBody {
  return {
    goal: args.goal.trim(),
    entryPoint: 'a2a-intent',
    intakeContext: [{ kind: 'a2a-task', id: args.taskId }],
  };
}

// ── Execution binding (spec 332 §10 / spec 334 §4 door 4, plan → run direction) ──────────────────

/** The input-body key the binding rides under on `message/send` — the A2A task record keeps the
 *  inbound message, so the keys survive on the task verbatim. */
export const ENDEAVOR_BINDING_KEY = 'endeavorBinding';

/** Build the `message/send` input for executing ONE compiled ExecutionIntent descriptor as an
 *  `orchestrate` task: the declarative goal + the adapter-contract provenance keys. */
export function buildEndeavorTaskInput(
  intent: ExecutionIntentDescriptorV1,
): { goal: string; endeavorBinding: ExecutionProvenanceKeysV1 } {
  return { goal: intent.goal, endeavorBinding: intent.provenance };
}

const HEX32_RE = /^0x[0-9a-f]{64}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

/** Fail-closed extraction of the binding from a task's input body: every adapter-contract key must
 *  be present and well-formed or the whole binding is absent (never a partial binding — a run that
 *  can't bind exactly is an unbound run, not an approximately-bound one, ADR-0013). */
export function parseEndeavorTaskBinding(input: unknown): ExecutionProvenanceKeysV1 | null {
  const raw = (input as Record<string, unknown> | null)?.[ENDEAVOR_BINDING_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const endeavorId = String(o.endeavorId ?? '');
  const planId = String(o.planId ?? '');
  const planRevision = Number(o.planRevision);
  const planHash = String(o.planHash ?? '').toLowerCase();
  const stepId = String(o.stepId ?? '');
  const commitmentRef = String(o.commitmentRef ?? '');
  const actor = String(o.actor ?? '').toLowerCase();
  const principal = String(o.principal ?? '').toLowerCase();
  const contextSnapshotHash = o.contextSnapshotHash === undefined ? undefined : String(o.contextSnapshotHash).toLowerCase();
  if (!endeavorId.startsWith('end_') || !planId.startsWith('plan_')) return null;
  if (!Number.isInteger(planRevision) || planRevision < 1) return null;
  if (!HEX32_RE.test(planHash) || !stepId.startsWith('step_') || !commitmentRef.startsWith('commit_')) return null;
  if (!ADDR_RE.test(actor) || !ADDR_RE.test(principal)) return null;
  if (contextSnapshotHash !== undefined && !HEX32_RE.test(contextSnapshotHash)) return null;
  return {
    endeavorId: endeavorId as ExecutionProvenanceKeysV1['endeavorId'],
    planId: planId as ExecutionProvenanceKeysV1['planId'],
    planRevision,
    planHash: planHash as ExecutionProvenanceKeysV1['planHash'],
    stepId: stepId as ExecutionProvenanceKeysV1['stepId'],
    commitmentRef: commitmentRef as ExecutionProvenanceKeysV1['commitmentRef'],
    actor: actor as ExecutionProvenanceKeysV1['actor'],
    principal: principal as ExecutionProvenanceKeysV1['principal'],
    ...(contextSnapshotHash ? { contextSnapshotHash: contextSnapshotHash as ExecutionProvenanceKeysV1['contextSnapshotHash'] } : {}),
  };
}

/** The `EndeavorStepExecutionInput` shape `projectEndeavorProvenance` takes (structural — the
 *  provenance package is a leaf; consumers adapt to ITS shapes, spec 316 §8). */
export interface BoundStepExecutionV1 {
  activityId: string;
  stepId: string;
  planId: string;
  planRevision: number;
  actor: string;
  actorClass?: 'person' | 'org' | 'service';
  role?: string;
  startedAt: string;
  endedAt?: string;
  usedRefs: string[];
  artifactRefs?: Array<string | { ref: string; derivedFrom?: string[] }>;
}

/** Project one bound A2A task run into the step-execution row `projectEndeavorProvenance` merges:
 *  activity = the task, `p-plan:correspondsToStep` = the bound step, `prov:used` = the commitment
 *  + snapshot refs (by hash), artifacts = the task's emitted artifacts. */
export function executionInputFromTask(task: {
  taskId: string;
  binding: ExecutionProvenanceKeysV1;
  startedAt: string;
  endedAt?: string;
  artifactRefs?: Array<string | { ref: string; derivedFrom?: string[] }>;
  actorClass?: 'person' | 'org' | 'service';
}): BoundStepExecutionV1 {
  const { binding } = task;
  return {
    activityId: `a2a-task:${task.taskId}`,
    stepId: binding.stepId,
    planId: binding.planId,
    planRevision: binding.planRevision,
    actor: binding.actor,
    ...(task.actorClass ? { actorClass: task.actorClass } : {}),
    role: 'committed-contributor',
    startedAt: task.startedAt,
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    usedRefs: [
      `commitment:${binding.commitmentRef}`,
      ...(binding.contextSnapshotHash ? [`snapshot:${binding.contextSnapshotHash}`] : []),
    ],
    ...(task.artifactRefs?.length ? { artifactRefs: task.artifactRefs } : {}),
  };
}
