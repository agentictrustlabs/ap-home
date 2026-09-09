// THE DELEGATED-TASK RAIL, as functions (spec 329 §3.1 / spec 372 S4 / spec 380). An organization sends ONE
// member's (or host's) agent one task over the FOLDED WIRE — A2A 1.0's `SendMessage` carrying the
// delegated-task extension, `GetTask` to collect — under the counterparty's own delegation: the org signs
// the envelope as itself (the interactions-session key under the steward-minted org wire), the receiving
// gate re-verifies the delegation per message, the receiving agent answers under its own playbook, and
// the org collects the structured artifact. Lifted out of `A2aTaskDO` so the topic turn (329), the
// archetype dispatch and the harness step (380) take exactly one path — and so that path is the folded
// wire: the DO's own callers were left speaking the retired `message/send` / `tasks/get` after S4, and
// every consult since then answered -32601.
//
// Authority never comes from here: the counterparty-signed grant is read fresh at every send (the §8
// stale-opt-in rule), and a member whose grant row is gone is simply not asked.
import { hashA2aMessage } from '@agenticprimitives/a2a';
import { delegatedInputPart, taskStateFromV1, withDelegatedTask, AP_DELEGATED_TASK_EXTENSION, type TaskV1 } from '@agenticprimitives/a2a/standard';
import { CONSULT_SKILL_ID, buildConsultRequest, validateConsultAnswer, type ConsultAnswerV1 } from '@agenticprimitives/fabric/messaging';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { internalHeaders } from './internal-marker.js';
import { wrapSessionSignature } from './session-wire.js';
import { interactionsSessionAccount, type Env, type IncomingDelegation } from './index.js';

const hashBody = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));

/** One in-Worker op on a principal's interactions object (marker-gated). Throws on a refused op. */
export async function interactionsInternal(env: Env, principal: string, op: string, payload: unknown): Promise<Record<string, unknown>> {
  const stub = env.INTERACTIONS.get(env.INTERACTIONS.idFromName(principal.toLowerCase()));
  const resp = await stub.fetch(new Request(`https://do/interactions/${principal.toLowerCase()}/${op}`, {
    method: 'POST', headers: internalHeaders(env), body: JSON.stringify(payload),
  }));
  const out = (await resp.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!resp.ok || out.ok === false) throw new Error(out.error ?? `${op} failed (${resp.status})`);
  return out;
}

/** The raw-digest signer of the interactions-session key (injectable so a test signs with a stub). */
export type RawSigner = (args: { hash: Hex }) => Promise<Hex>;

/** Session-wrapped org signature over a rail digest (§3.1): the interactions-session KMS key signs; the
 *  steward-minted org wire authorizes. No raw key at rest. */
export async function signAsOrg(env: Env, orgWire: IncomingDelegation, digest: Hex, signRaw?: RawSigner): Promise<Hex> {
  const sign = signRaw ?? (await interactionsSessionAccount(env)).sign;
  if (!sign) throw new Error('interactions-session KMS account lacks raw-digest sign');
  return wrapSessionSignature(orgWire, await sign({ hash: digest }));
}

/** Spec 384 W2 — sign a digest AS an agent served here, under its own DEL-001 session leaf (principal → the
 *  interactions-session key). The result verifies ERC-1271 against the agent. Null when the agent holds no
 *  leaf in this deployment — then it cannot sign as itself, and a firm offer is not minted for it. */
export async function signAsAgent(env: Env, agent: string, digest: Hex, signRaw?: RawSigner): Promise<Hex | null> {
  let leaf: IncomingDelegation | null = null;
  try { leaf = ((await interactionsInternal(env, agent, 'internal.session.leaf', {})) as { leaf?: IncomingDelegation | null }).leaf ?? null; } catch { return null; }
  if (!leaf?.signature) return null;
  return signAsOrg(env, leaf, digest, signRaw);
}

/** The org's own consult wire, or null when the routing ceremony has not minted one. */
export async function orgConsultWire(env: Env, org: string): Promise<IncomingDelegation | null> {
  const r = (await interactionsInternal(env, org, 'internal.consult.orgWire', {})) as { wire?: IncomingDelegation | null };
  return r.wire ?? null;
}

/** The member's consultability grant to this org, read FRESH (the §8 rule), or null. */
export async function memberConsultGrant(env: Env, org: string, member: string): Promise<IncomingDelegation | null> {
  const r = (await interactionsInternal(env, org, 'internal.consult.grant', { member: member.toLowerCase() })) as { wire?: IncomingDelegation | null };
  return r.wire ?? null;
}

/** ONE 1.0 request to a target agent's own task object, in-Worker, calling AS the org (the door's
 *  authentication, which a DO-internal call replaces with the envelope's principal). */
async function rpcAs(env: Env, target: string, org: string, rpc: unknown): Promise<{ result?: unknown; error?: { code?: number; message?: string } }> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(target.toLowerCase()));
  const resp = await stub.fetch(new Request(`https://a2a-task-do/rpc?agent=${target.toLowerCase()}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpc, principal: { agent: org.toLowerCase() } }),
  }));
  return (await resp.json().catch(() => ({ error: { message: `no JSON from ${target}` } }))) as { result?: unknown; error?: { code?: number; message?: string } };
}

export interface SubmitDelegatedTaskArgs {
  org: string; orgWire: IncomingDelegation; grant: IncomingDelegation; target: string; skill: string; input: unknown; signRaw?: RawSigner;
}

/** Send ONE delegation-authorized task to a target agent over the folded wire. Returns the task id; throws
 *  when the target's gate refuses. */
export async function submitDelegatedTask(env: Env, args: SubmitDelegatedTaskArgs): Promise<{ taskId: Hex; messageId: Hex; state: string }> {
  const target = args.target.toLowerCase();
  const org = args.org.toLowerCase();
  const idBytes = new Uint8Array(32);
  crypto.getRandomValues(idBytes);
  const messageId = (`0x${Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('')}`) as Hex;
  const createdAt = Math.floor(Date.now() / 1000);
  const bodyHash = hashBody(args.input);
  const digest = hashA2aMessage({ messageId, sender: org as Address, skill: args.skill, bodyHash, createdAt });
  const signature = await signAsOrg(env, args.orgWire, digest, args.signRaw);
  const message = withDelegatedTask(
    { messageId, role: 'ROLE_USER', parts: [delegatedInputPart(args.input)] },
    { delegation: args.grant as never, requester: org, skill: args.skill, sender: org, bodyHash, bodyRef: { owner: target, recordType: 'pending' }, signature, createdAt },
  );
  const out = await rpcAs(env, target, org, { jsonrpc: '2.0', id: messageId, method: 'SendMessage', params: { message } });
  const task = (out.result as { task?: TaskV1 } | undefined)?.task;
  if (out.error || !task?.id) throw new Error(out.error?.message ?? `SendMessage to ${target} returned no task`);
  return { taskId: task.id as Hex, messageId, state: taskStateFromV1(task.status?.state ?? '') };
}

export interface DelegatedTaskRead { state: string; artifactIds: string[]; error?: string }

/** ONE look at a delegated task on the target's runtime, as the org (a party to it). */
export async function readDelegatedTask(env: Env, args: { org: string; target: string; taskId: Hex }): Promise<DelegatedTaskRead> {
  const out = await rpcAs(env, args.target, args.org, { jsonrpc: '2.0', id: args.taskId, method: 'GetTask', params: { id: args.taskId } });
  if (out.error) throw new Error(`GetTask refused by ${args.target}: ${out.error.message ?? 'unknown'}`);
  const task = out.result as TaskV1;
  const state = taskStateFromV1(task?.status?.state ?? '');
  const artifactIds = (task?.artifacts ?? []).map((a) => String(a.artifactId ?? '')).filter(Boolean);
  const error = task?.status?.message?.parts?.map((p) => p.text ?? '').join(' ').trim();
  return { state, artifactIds, ...(error ? { error } : {}) };
}

/** Read one artifact body from the TARGET's runtime (marker-gated door, AFTER the party check GetTask made —
 *  see /internal/consult-artifact: only the task's sender may read). */
export async function readTaskArtifact(env: Env, target: string, taskId: Hex, org: string, artifactId: string): Promise<unknown> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(target.toLowerCase()));
  const resp = await stub.fetch(new Request(`https://a2a-task-do/internal/consult-artifact?agent=${target.toLowerCase()}`, {
    method: 'POST', headers: internalHeaders(env), body: JSON.stringify({ taskId, caller: org, artifactId }),
  }));
  const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; body?: unknown; error?: string };
  if (!resp.ok || out.ok !== true) throw new Error(out.error ?? `artifact read failed (${resp.status})`);
  return out.body ?? null;
}

export { AP_DELEGATED_TASK_EXTENSION };

export interface SubmitConsultArgs {
  org: string; orgWire: IncomingDelegation; grant: IncomingDelegation; memberSA: string; question: string;
  topicId: string; questionId: string; topicTitle?: string; tail?: Array<{ author: string; bodyText: string }>;
  signRaw?: RawSigner;
}

/** Send ONE consult to a member's agent. Returns the task id; throws when the member's gate refuses. */
export async function submitConsult(env: Env, args: SubmitConsultArgs): Promise<{ taskId: Hex; messageId: Hex }> {
  const request = buildConsultRequest({
    question: args.question, orgSA: args.org, topicId: args.topicId, questionId: args.questionId,
    ...(args.topicTitle ? { topicTitle: args.topicTitle } : {}), ...(args.tail?.length ? { tail: args.tail } : {}),
  });
  const sent = await submitDelegatedTask(env, { org: args.org, orgWire: args.orgWire, grant: args.grant, target: args.memberSA, skill: CONSULT_SKILL_ID, input: request, ...(args.signRaw ? { signRaw: args.signRaw } : {}) });
  return { taskId: sent.taskId, messageId: sent.messageId };
}

/** A consult's answer artifact is a task artifact (kept under its old name for the topic rail). */
export const readConsultArtifact = readTaskArtifact;

export type ConsultCollected =
  | { state: 'pending'; taskState: string }
  | { state: 'answered'; answer: string; artifact: ConsultAnswerV1 }
  | { state: 'declined'; reason?: string; artifact: ConsultAnswerV1 }
  | { state: 'failed'; error: string };

/** ONE look at a sent consult: a SIGNED tasks/get on the member's runtime, then the artifact. The
 *  distinctions cost the topic rail to learn — a terminal failure, a still-running task and an
 *  unreadable artifact are three different answers. */
export async function collectConsult(env: Env, args: { org: string; orgWire: IncomingDelegation; memberSA: string; taskId: Hex; signRaw?: RawSigner }): Promise<ConsultCollected> {
  const memberSA = args.memberSA.toLowerCase();
  let read: DelegatedTaskRead;
  try { read = await readDelegatedTask(env, { org: args.org, target: memberSA, taskId: args.taskId }); } catch (e) { return { state: 'failed', error: e instanceof Error ? e.message : String(e) }; }
  const st = read.state;
  if (st === 'failed' || st === 'rejected' || st === 'canceled') return { state: 'failed', error: `the member's agent ${st}${read.error ? `: ${read.error}` : ''}` };
  if (st !== 'completed') return { state: 'pending', taskState: st };
  const artifactId = read.artifactIds[0];
  if (!artifactId) return { state: 'failed', error: 'completed with no artifact to read' };
  const body = (await readTaskArtifact(env, memberSA, args.taskId, args.org, artifactId)) as ConsultAnswerV1 | null;
  if (!body || validateConsultAnswer(body).length > 0) return { state: 'failed', error: 'the answer artifact was not a consult answer' };
  if (body.declined === true) return { state: 'declined', ...(body.declineReason ? { reason: body.declineReason } : {}), artifact: body };
  return { state: 'answered', answer: String(body.answer ?? ''), artifact: body };
}

/** Poll until the consult is terminal or the deadline passes (then `pending` is the answer). */
export async function awaitConsult(env: Env, args: { org: string; orgWire: IncomingDelegation; memberSA: string; taskId: Hex; deadlineMs: number; everyMs?: number; signRaw?: RawSigner }): Promise<ConsultCollected> {
  const until = Date.now() + args.deadlineMs;
  const every = args.everyMs ?? 1500;
  let last: ConsultCollected = { state: 'pending', taskState: 'submitted' };
  while (Date.now() < until) {
    last = await collectConsult(env, args);
    if (last.state !== 'pending') return last;
    await new Promise((r) => setTimeout(r, every));
  }
  return last;
}

