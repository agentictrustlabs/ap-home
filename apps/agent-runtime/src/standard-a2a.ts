// THE STANDARD A2A 1.0 SURFACE, MOUNTED — spec 372 S2 (session-bearer mode).
//
// `POST /api/a2a` serves ONE wire — A2A 1.0 — and two things behind it (spec 372 S4, the fold):
//
//   · a message carrying the DELEGATED-TASK EXTENSION is the agent-to-agent task: it goes to this agent's
//     own object, where the runtime authorizes the grant, persists the task and dispatches the skill. That
//     used to be a second set of method names (`message/send`, `tasks/get`); the authority they carried is
//     now the extension, and every gate behind it is the same one.
//   · a message carrying none is a CONVERSATION: the text goes through `/harness/ask` in-process under the
//     addressee's playbook, and the reply's kind becomes the task's state.
//
// Who is calling is the `Authorization` header either way — a person's Home session bearer, or an agent's
// session wire (`caller.ts`). Nothing on this surface is a mandate: an act the ask reaches still needs the
// mandate the harness demands, and a task parked `TASK_STATE_AUTH_REQUIRED` carries what it would need.
//
// WHAT IS THE PACKAGE'S, since spec 399 W0 (§4): the card's 1.0 fields, the task-id shape, the one task view
// over the runtime's tasks and this server's, the two admission schemes, the delegated/engagement dispatch and
// the reply-kind → state table (`@agenticprimitives/a2a/standard` `mount.ts`); the routed hop's profiles
// (`subject-hop.ts`); the flow trace (`orchestration`). WHAT IS THIS APP'S: the ask route it calls in-process,
// the in-Worker marker, what it parks for stewards, and which artifacts it hangs on a task.
//
// Conversational task rows are a per-isolate projection (in memory); a delegated task lives in the object
// that owns it. Nothing a person cannot rebuild is in either (ADR-0055).
import { buildFlowTrace, flowIdOf, referralOf, traceContextOf } from '@agenticprimitives/orchestration';
import { hasProvenanceRef } from './run-export.js';
/** Spec 400 W2a — `metadata.presented` on an agent caller's CONTINUATION: the mandate chain it presents for a run of
 *  its own that parked as AUTH_REQUIRED — a standing grant its custodian signed once and the child it derived for
 *  this intent. Shape-checked here; VERIFIED by the harness where it is used (signatures, revocation, subset, the
 *  intent binding). Anything else is ignored, not guessed. */
export function presentedOf(metadata: Record<string, unknown> | undefined): Array<Record<string, unknown>> | null {
  const p = metadata?.presented;
  if (!Array.isArray(p) || !p.length || p.length > 5) return null;
  const ok = p.every((w) => w && typeof w === 'object' && ['delegator', 'delegate', 'authority', 'salt', 'signature'].every((k) => typeof (w as Record<string, unknown>)[k] === 'string') && Array.isArray((w as { caveats?: unknown }).caveats));
  return ok ? (p as Array<Record<string, unknown>>) : null;
}

/** `metadata.plan` on an agent caller's message — `{ steps: [{ toolId, args }] }` or nothing; anything else is ignored, not guessed. */
function supplierPlanOf(metadata: Record<string, unknown> | undefined): Plan | null {
  const p = metadata?.plan as { steps?: unknown } | undefined;
  if (!p || !Array.isArray(p.steps) || !p.steps.length) return null;
  const steps = p.steps
    .filter((st): st is { toolId: string; args?: unknown } => !!st && typeof (st as { toolId?: unknown }).toolId === 'string')
    .map((st) => ({ toolId: st.toolId, args: (st.args && typeof st.args === 'object' ? st.args : {}) as Record<string, unknown> }));
  return steps.length ? { steps } : null;
}

import type { Plan, RunEvent, SuppliedInputV1 } from '@agenticprimitives/orchestration';
import type { Address } from 'viem';
import {
  createStandardA2aServer, createMemoryTaskStore, createMemoryPushStore, sessionWirePrincipal,
  runtimeBackedTaskStore, delegatedDispatch, canSeeDelegatedOrOwnTask, principalBySchemes, partsText, partsData, traceHeadersOf,
  settlementForReplyKind, settleTask,
  type AgentCardV1, type ExecutionContext, type MessageV1, type Principal, type StandardServer, type SessionWirePrincipalDeps, type StandardTaskStore, type DelegatedRpc,
} from '@agenticprimitives/a2a/standard';
import { internalHeaders, markInWorker, isInWorkerRequest, type InternalMarkerEnv } from './internal-marker.js';
import { subjectAskOf, subjectAnswerOf, handoffOf, routedRunRefFor, SUBJECT_ANSWER_ARTIFACT, type HandoffV1, type SubjectAnswerV1 } from '@agenticprimitives/a2a';

export interface StandardMountDeps {
  env: InternalMarkerEnv & Record<string, unknown>;
  /** The Worker's own app, so the ask runs in-process (a Worker cannot fetch its own hostname). Called with
   *  THIS request's execution context — Hono refuses `c.executionCtx` without one, and the ask route uses it. */
  appFetch: (request: Request, env: unknown) => Promise<Response>;
  /** Verifies a Home session token → the person's SA. */
  verifySession: (token: string) => Promise<{ ok: true; sa: Address } | { ok: false; status: number; error: string }>;
  /** Spec 372 S3c — the chain checks behind an AGENT's session wire. Absent ⇒ only people are admitted. */
  wire?: Pick<SessionWirePrincipalDeps, 'enforcers' | 'verifyDelegationSig' | 'isRevoked' | 'verifyAgentSignature'>;
  /** Spec 372 S3c — spend a caller's assertion once, at the addressed agent's own object. */
  claimAssertion?: (agent: Address, digest: string, expiresAtMs: number) => Promise<boolean>;
  /** Spec 372 S4 — forward a 1.0 request to the agent's own object, where the delegation-authorized
   *  runtime lives. Returns the JSON-RPC response verbatim. */
  delegatedRpc?: DelegatedRpc;
  /** Spec 372 S3c — an agent asking as itself: no session, no mandate, its own standing. */
  askAsAgent?: (input: { agent: Address; addressee: Address; ask: string; runRef: string; /** Spec 390 W2 — the caller's W3C Trace Context, kept on the run's record. */ traceContext?: import('@agenticprimitives/orchestration').TraceContextV1 | null; /** Spec 390 W3 — when the request arrived. */ receivedAt?: number; /** The message's DATA part, when it carried one naming a skill — the material `playbook.answer` reasons over. */ material?: Record<string, unknown> | null; /** Spec 400 W1 — a plan the caller supplied in the message's metadata; admitted by the harness like any supplied plan (367 W1), never trusted. */ plan?: Plan | null }) => Promise<{
    reply: { kind: string; text?: string; prompt?: { kind: string; prompt: string; stepRef: string }; error?: string };
    spoken: string;
    result?: { plan: unknown };
    /** Spec 387 W2 — the run's events, for the `trace` artifact an outside caller reads. */
    events?: RunEvent[];
  }>;
  /** Spec 387 W3 — CONTINUE a run this agent parked for an outside agent: the caller's answer to the prompt,
   *  applied to the checkpoint (plan replayed, completed steps replayed, the answer supplied for the waiting
   *  step). Refused unless the run parked for exactly this caller and is still waiting. */
  resumeAsAgent?: (input: { agent: Address; addressee: Address; runRef: string; data: Record<string, unknown>; /** Spec 400 W2a — the chain the agent presents for its own run that parked for authority. */ presented?: Array<Record<string, unknown>> | null }) => Promise<{
    reply: { kind: string; text?: string; prompt?: { kind: string; prompt: string; stepRef: string }; error?: string };
    spoken: string; result?: { plan: unknown }; events?: RunEvent[];
  } | { refused: string }>;
  /** Spec 372 N1 — an outsider's act or question PARKS, open to the addressee's stewards, exactly as a
   *  trigger's does (P5): listed among their unfinished runs, finished by one of them under their own
   *  session and their own mandate. The A2A task is the runtime's handle; this is the stewards'. */
  parkRun?: (input: { runRef: string; ask: string; addressee: Address; asker: Address; reply: { kind: string; prompt?: { kind: string; prompt: string; stepRef: string } }; result?: { plan: unknown } }) => Promise<void>;
  /** Spec 374 §4 — THE DEBTOR'S ANSWER ARRIVES: a routed act this agent's run was waiting on finished at
   *  the subject's agent. Finds the run on THIS agent's object that suspended on exactly that commitment
   *  (debtor = the caller, id = `inResponseTo.operationId`) and resumes it with the delivered outcome.
   *  No such run ⇒ `{ ok: false }` and the task is rejected with words that do not say whether one exists. */
  resumeFromCommitment?: (input: { addressee: Address; debtor: Address; answer: SubjectAnswerV1 }) => Promise<{ ok: true; runRef: string; said: string } | { ok: false; reason: string }>;
  /** Spec 376 — RUN ONE HANDED-OFF STEP at this agent under the chain the parent sent, the parent agent as
   *  the asker (an agent holding a mandate). Returns the `/harness/ask`-shaped envelope the parent reads. */
  runHandoff?: (input: { executor: Address; parent: Address; handoff: HandoffV1 }) => Promise<Record<string, unknown>>;
  /** Spec 384 W2 — answer an engagement probe AS this agent (an offer, a decline, a question…). The reply is a
   *  MESSAGE, never a task (336 §5). Absent ⇒ probes are not answered here. */
  answerProbe?: (input: { agent: Address; probe: Record<string, unknown>; caller: Principal | null }) => Promise<Record<string, unknown>>;
  /** Spec 412 — THE PUBLIC SHELF: answer a public read (`library.public.list` / `library.public.read`) AS this agent for a
   *  caller with no credential. Reads only what the owner marked public. Absent ⇒ the lane is closed (every anonymous
   *  request stays 401). */
  publicRead?: (input: { agent: Address; skill: string; args: Record<string, unknown> }) => Promise<Record<string, unknown>>;
}

/** Spec 412 — the data-part shape a stranger sends: `{ skill: 'library.public.list' | 'library.public.read', ...args }`. */
export const PUBLIC_LANE_SKILLS: ReadonlySet<string> = new Set(['library.public.list', 'library.public.read']);
export function publicLaneSkillOf(message: { parts: MessageV1['parts'] }): { skill: string; args: Record<string, unknown> } | null {
  const data = partsData(message.parts);
  const skill = data && typeof data.skill === 'string' ? data.skill : null;
  if (!skill || !PUBLIC_LANE_SKILLS.has(skill)) return null;
  const { skill: _s, ...args } = data as Record<string, unknown>;
  return { skill, args };
}

interface AskEnvelope {
  ok?: boolean; error?: string; detail?: string; spoken?: string;
  reply?: { kind?: string; runRef?: string; text?: string; summary?: string; results?: Array<{ toolId: string; result: unknown }>; prompt?: { kind?: string; stepRef?: string; prompt?: string; fields?: Array<{ name?: string }> }; requirement?: unknown; effects?: unknown; receipt?: unknown };
}

/** The STORES persist per agent per isolate; the server is rebuilt per request so it carries that
 *  request's execution context and card (a stale context would refuse the ask route's `waitUntil`). */
const stores = new Map<string, { tasks: ReturnType<typeof createMemoryTaskStore>; push: ReturnType<typeof createMemoryPushStore> }>();

export function standardServerFor(agent: Address, card: AgentCardV1, host: string, deps: StandardMountDeps): StandardServer {
  const key = `${agent.toLowerCase()}@${host}`;
  let st = stores.get(key);
  if (!st) { st = { tasks: createMemoryTaskStore(), push: createMemoryPushStore() }; stores.set(key, st); }
  const byWire = deps.wire
    ? sessionWirePrincipal({
        ...deps.wire,
        // THE SINGLE WRITER SPENDS IT (spec 372 S3c). The addressed agent's own object decides which caller
        // was first; a per-isolate memory is not replay protection on a fanned-out edge, as a live replay
        // showed on 2026-09-08. Unreachable ⇒ the call is refused, never admitted into a replay window.
        ...(deps.claimAssertion ? { claim: (digest, expiresAt) => deps.claimAssertion!(agent, digest, expiresAt) } : {}),
        onRefused: (reason, who) => console.warn(`[standard-a2a] wire refused for ${who ?? '?'}: ${reason}`),
      })
    : null;
  // ONE TASK VIEW over two stores (spec 372 S4): the package's, bound to this agent's object.
  const tasks: StandardTaskStore = deps.delegatedRpc ? runtimeBackedTaskStore({ local: st.tasks, agent, rpc: deps.delegatedRpc }) : st.tasks;

  const server = createStandardA2aServer({
    card,
    tasks,
    push: st.push,
    // A delegated task is the runtime's — it keeps its id; an engagement PROBE is answered with a MESSAGE and no
    // task (spec 384 W2 / 336 §5). The package's dispatch; this agent's runtime and probe answerer behind it.
    ...delegatedDispatch({ agent, ...(deps.delegatedRpc ? { rpc: deps.delegatedRpc } : {}), ...(deps.answerProbe ? { answerProbe: deps.answerProbe } : {}) }),
    // A delegated task is visible to its parties; a conversation, to whoever had it.
    canSeeTask: canSeeDelegatedOrOwnTask,
    // Spec 412 — THE PUBLIC LANE: a stranger's `SendMessage` whose data part names a public shelf read is answered
    // with a message (no task) from what the owner marked public. The package admits the shape; this agent answers.
    ...(deps.publicRead ? {
      public: {
        admits: (m: MessageV1) => publicLaneSkillOf(m) !== null,
        answer: async (m: MessageV1) => {
          const q = publicLaneSkillOf(m)!;
          const result = await deps.publicRead!({ agent, skill: q.skill, args: q.args });
          const said = typeof result.answer === 'string' ? result.answer : '';
          return { messageId: crypto.randomUUID(), role: 'ROLE_AGENT' as const, parts: [...(said ? [{ text: said }] : []), { data: { skill: q.skill, ...result } }] } as never;
        },
      },
    } : {}),
    // TWO SCHEMES, ONE MECHANISM EACH (ADR-0013) — the package's selector. `first` is THIS Worker's own door:
    // spec 374 §4 — AN AGENT OF THIS WORKER, calling in-process. A Worker cannot fetch its own account's
    // hostnames, so a subject agent delivering a finished act to a creditor agent served here makes the
    // hop through this handler with the in-Worker marker (spec 341 §7) and names itself. The marker is
    // the door; the name is checked against the run it claims to answer, never trusted beyond that.
    principal: principalBySchemes({
      first: (request) => {
        const internalAgent = request.headers.get('x-ap-internal-agent');
        if (!internalAgent || !/^0x[0-9a-fA-F]{40}$/.test(internalAgent)) return undefined;
        // R917-E-4 (spec 409 §6): the in-isolate MARK, never the header — a request over a socket can name an
        // agent in a header, but it cannot be in this isolate's WeakSet.
        return isInWorkerRequest(request) ? { kind: 'agent', agent: internalAgent.toLowerCase() } : null;
      },
      wire: byWire,
      bearer: async (token) => { const who = await deps.verifySession(token); return who.ok ? { agent: who.sa.toLowerCase(), session: token } : null; },
    }),
    executor: {
      execute: async (ctx: ExecutionContext) => {
        const session = String(ctx.principal?.session ?? '');
        const message = partsText(ctx.message.parts);
        // AN AGENT ASKING AS ITSELF (spec 372 S3c). It has no person's session and is given none: the run
        // is the same one a trigger fires — no mandate presented, reads bounded to what this agent's own
        // records say to that asker, an act suspending as AUTH_REQUIRED with what it would need.
        // Spec 376 — A HAND-OFF: another agent's harness asks this agent to run ONE step under a child
        // mandate it attenuated from the mandate its person granted. The caller is the parent agent; the
        // chain is verified by THIS harness where it is used, never trusted from the message.
        const handed = handoffOf(ctx.message);
        if (handed && 'errors' in handed) { await ctx.reject([{ text: `the hand-off is malformed: ${handed.errors.join('; ')}` }]); return; }
        if (handed) {
          if (ctx.principal?.kind !== 'agent' || !deps.runHandoff) { await ctx.reject([{ text: 'a hand-off comes from the agent whose run it is a step of' }]); return; }
          if (ctx.principal.agent.toLowerCase() !== handed.handoff.parent.agent.toLowerCase()) { await ctx.reject([{ text: 'the hand-off names a parent other than its caller' }]); return; }
          await ctx.working();
          const envelope = await deps.runHandoff({ executor: agent, parent: ctx.principal.agent as Address, handoff: handed.handoff });
          await ctx.artifact({ name: SUBJECT_ANSWER_ARTIFACT, parts: [{ data: envelope }] });
          const reply = envelope.reply as { kind?: string; text?: string; error?: string; prompt?: { prompt?: string }; summary?: string } | undefined;
          const said = reply?.text || reply?.summary || reply?.prompt?.prompt || reply?.error || '';
          // A hand-off's need parks as INPUT_REQUIRED either way: the parent holds the mandate, not the caller here.
          const how = settlementForReplyKind(reply?.kind);
          if (how === 'completed') { await ctx.complete([{ text: said || 'Done.' }]); return; }
          if (how === 'input-required' || how === 'auth-required') { await ctx.inputRequired([{ text: said || 'More is needed.' }]); return; }
          await ctx.reject([{ text: said || 'Refused.' }]);
          return;
        }
        // Spec 374 §4 — a DELIVERED ANSWER to a routed act this agent's run is waiting on. The caller is the
        // debtor (an agent); the match against a run this agent itself suspended is the only authorization.
        const delivered = subjectAnswerOf(ctx.message);
        if (delivered && 'errors' in delivered) { await ctx.reject([{ text: `the delivered answer is malformed: ${delivered.errors.join('; ')}` }]); return; }
        if (delivered) {
          if (ctx.principal?.kind !== 'agent' || !deps.resumeFromCommitment) { await ctx.reject([{ text: 'a delivered answer comes from the agent that owed it' }]); return; }
          await ctx.working();
          const r = await deps.resumeFromCommitment({ addressee: agent, debtor: ctx.principal.agent as Address, answer: delivered.answer });
          // A resume that FAILED is said as such (the debtor is not a stranger and the words help); a run
          // that does not exist is not confirmed or denied.
          if (!r.ok) { await ctx.reject([{ text: r.reason.startsWith('the waiting run') ? r.reason : 'nothing this agent is waiting on matches that answer' }]); return; }
          ctx.task.metadata = { ...(ctx.task.metadata ?? {}), runRef: r.runRef, hasProvenance: hasProvenanceRef(agent, r.runRef) };
          await ctx.complete([{ text: r.said || 'The waiting run finished.' }]);
          return;
        }
        if (!session && ctx.principal?.kind === 'agent' && deps.askAsAgent) {
          const caller = ctx.principal.agent as Address;
          const startedAt = Date.now();
          const flowId = flowIdOf(ctx.message);
          const referral = referralOf(ctx.message);
          // Whose conversation this is: a later GetTask or a continuation from anyone else is refused (spec 372 S4).
          ctx.task.metadata = { ...(ctx.task.metadata ?? {}), asker: caller };
          // Spec 387 W3 — A CONTINUATION: the same caller answers the prompt the run parked on. The task's own
          // metadata says which run; the checkpoint says which step and who may answer; the answer is the data part.
          const parkedRef = typeof ctx.task.metadata?.runRef === 'string' && ctx.task.metadata.openToStewards === true ? ctx.task.metadata.runRef : undefined;
          const answer = partsData(ctx.message.parts);
          let runRef = `svc-${ctx.task.id}`;
          let asked: Awaited<ReturnType<NonNullable<typeof deps.askAsAgent>>>;
          if (parkedRef && deps.resumeAsAgent) {
            const presented = presentedOf(ctx.message.metadata);
            if (!answer && !presented) { await ctx.reject([{ text: 'A continuation carries the answer as a data part keyed by the prompt\'s field names, or the mandate chain it presents in metadata.presented.' }]); return; }
            await ctx.working();
            runRef = parkedRef;
            const resumed = await deps.resumeAsAgent({ agent: caller, addressee: agent, runRef: parkedRef, data: answer ?? {}, ...(presented ? { presented } : {}) });
            if ('refused' in resumed) { await ctx.reject([{ text: resumed.refused }]); return; }
            asked = resumed;
          } else {
            if (!message) { await ctx.reject([{ text: 'Say what you would like this agent to do — the message carried no text.' }]); return; }
            await ctx.working();
            // THE DATA PART TRAVELS TOO. A card room asks for advice with the seat's view as data and the
            // question as text; the text alone gave the planner "advise seat 0" and nothing to advise ON.
            const material = partsData(ctx.message.parts);
            const askT0 = Date.now();
            // Spec 400 W1 — a SUPPLIED PLAN from an agent caller (`metadata.plan`): an outside runtime's poll of its own inbox
            // is a deterministic read and need not cost a planner turn. The harness admits it against the playbook's tools
            // (367 W1) exactly as it admits the Home's; a plan naming a tool the agent does not have is refused there.
            const suppliedPlan = supplierPlanOf(ctx.message.metadata);
            asked = await deps.askAsAgent({ agent: caller, addressee: agent, ask: message, runRef, traceContext: traceContextOf(ctx.headers), receivedAt: startedAt, ...(material && typeof material.skill === 'string' ? { material } : {}), ...(suppliedPlan ? { plan: suppliedPlan } : {}) });
            if (material) console.log(`[phases surface] principal→ask ${askT0 - startedAt}ms · ask ${Date.now() - askT0}ms`);
          }
          // Spec 387 W2 — THE TRACE RIDES WITH THE TASK: what admitted the run, what was offered and chosen, each
          // step's outcome and output summary, in order. Evidence of what ran; nothing in it is authority or private.
          const reply = asked.reply as typeof asked.reply & { plannerTrace?: never; results?: Array<{ toolId: string; result: unknown }> };
          const artifactNames = [...(reply.results?.length ? ['results'] : []), 'trace'];
          const trace = buildFlowTrace({ flowId, traceId: traceContextOf(ctx.headers)?.traceId ?? null, runRef, agent, asker: caller, startedAt, reply: reply as never, ...(asked.events ? { events: asked.events } : {}), artifacts: artifactNames, ...(referral ? { referral } : {}), ...(parkedRef ? { continued: true } : {}) });
          console.log(`[flow ${flowId ?? '-'}] agent ${agent} run ${runRef}${parkedRef ? ' (continued)' : ''} ← ${caller}: ${reply.kind} · planner ${trace.planner?.kind ?? '-'} · steps ${trace.steps.map((st) => `${st.toolId}${st.ok ? '' : '✗'}`).join(',') || 'none'} · ${trace.ms}ms${referral ? ` · referral ${referral.registry}` : ''}`);
          // Spec 354 K4 — THE PLAYBOOK MANIFEST (`skill-provenance/v1`, from the run's receipts: archetype id, version,
          // definition digest) rides on every artifact the task carries, so an outside verifier checks WHICH procedure
          // shaped this answer against the corpus by digest. Names a procedure; grants nothing.
          const manifest = (asked.reply as { skillProvenance?: Record<string, unknown> }).skillProvenance;
          await ctx.artifact({ name: 'trace', parts: [{ data: trace }], ...(manifest ? { metadata: manifest } : {}) });
          // THE WRITTEN REPLY, not the spoken one. `spoken` is rendered for a voice — it says "alice2 dot
          // treasury" — and an A2A peer reading that gets a mangled name it cannot resolve (seen live,
          // 2026-09-08). A voice surface asks for `spoken`; this wire wants what was written.
          const words = asked.reply.text || asked.spoken || '';
          if (asked.reply.kind === 'answer' || asked.reply.kind === 'done') {
            // Spec 387 W2 — WHAT THE STEPS RETURNED rides beside the words, as the routed reply's does below: a
            // catalog search's items (each with its link) are an artifact the caller can act on, not a sentence to re-parse.
            const results = (asked.reply as { results?: Array<{ toolId: string; result: unknown }> }).results;
            if (results?.length) await ctx.artifact({ name: 'results', parts: [{ data: results }], ...(manifest ? { metadata: manifest } : {}) });
            await ctx.complete([{ text: words || 'Done.' }]); return;
          }
          // WHAT THE OUTSIDER CANNOT FINISH, A STEWARD CAN (spec 372 N1). The task parks for the caller; the
          // same run parks open to the addressee's stewards, who see it where they see every other
          // unfinished run and finish it with their own signature — the runtime never holds that pen.
          // A prompt the CALLER can answer is also open to the caller (W3): the checkpoint names it as the outsider.
          if (asked.reply.kind === 'prompt' || asked.reply.kind === 'authority_required') {
            ctx.task.metadata = { ...(ctx.task.metadata ?? {}), runRef, openToStewards: true, hasProvenance: hasProvenanceRef(agent, runRef) };
            if (!parkedRef) await deps.parkRun?.({ runRef, ask: message, addressee: agent, asker: caller, reply: asked.reply, ...(asked.result ? { result: asked.result } : {}) }).catch((e: unknown) => console.warn('[standard-a2a] park failed:', e instanceof Error ? e.message : String(e)));
          }
          if (asked.reply.kind === 'prompt') { await ctx.inputRequired([{ text: asked.reply.prompt?.prompt ?? words }, { data: asked.reply.prompt ?? {} }]); return; }
          if (asked.reply.kind === 'authority_required') {
            // Spec 400 W2a — WHAT IT WOULD NEED rides on the task: the requirement (capability, location, window, the
            // intent digest) and the parties, so an agent holding a standing grant can DERIVE the child for this very
            // intent and continue; a steward at the Home reads the same. Names an authority; grants none.
            const need = asked.reply as { requirement?: unknown; delegator?: string; delegate?: string; alsoApprove?: unknown };
            await ctx.authRequired([{ text: words || 'This needs a mandate no one has granted.' }, { data: { runRef, openToStewards: true, ...(need.requirement ? { requirement: need.requirement } : {}), ...(need.delegator ? { delegator: need.delegator } : {}), ...(need.delegate ? { delegate: need.delegate } : {}), ...(need.alsoApprove ? { alsoApprove: need.alsoApprove } : {}) } }]); return;
          }
          await ctx.reject([{ text: words || asked.reply.error || 'Refused.' }]);
          return;
        }
        // A SUBJECT-ASK FROM ANOTHER DEPLOYMENT (spec 366 R4). Another agent's harness routed one step here,
        // about THIS agent, under the asker's Home session (the bearer) and the profile in the metadata.
        // It is the same request the in-process hop makes — the same `/harness/ask` body, the same
        // consistency checks there (credential = verified session, asker = session's agent, plan =
        // request) — and the envelope it answers with rides back verbatim as the `subject-answer`
        // artifact, so the sender reads it exactly as it reads the in-process reply.
        const routed = subjectAskOf(ctx.message);
        if (routed && 'errors' in routed) { await ctx.reject([{ text: `the subject-ask profile is malformed: ${routed.errors.join('; ')}` }]); return; }
        if (routed) {
          // Spec 397 W4 — a routed ask from a run asked THROUGH A CLIENT carries the forwarded app credential inside the
          // profile instead of a session; `/harness/ask` verifies it as the receiver (wire on chain, assertion, the
          // audience a peer deployment this one names). No session and no such credential is refused as before.
          const forwarded = routed.ask.asker.credential.kind === 'app-delegation';
          if (!session && !forwarded) { await ctx.reject([{ text: 'a routed ask carries the asker’s Home session as the bearer (or the forwarded app credential in the profile); this one carried neither' }]); return; }
          if (ctx.principal?.agent) ctx.task.metadata = { ...(ctx.task.metadata ?? {}), asker: ctx.principal.agent };
          const ask = routed.ask;
          const wholeAsk = ask.request.capability === 'harness.ask';
          const body = JSON.stringify({ ...(session ? { session } : {}), addressee: agent, message: ask.request.goal, ...(wholeAsk ? {} : { plan: { steps: [{ toolId: ask.request.capability, args: ask.request.args }] } }), subjectAsk: ask, ...(ask.continue ? {} : { runRef: routedRunRefFor(ask.correlation) }) });
          await ctx.working();
          const res = await deps.appFetch(markInWorker(new Request(`https://${host}/harness/ask`, { method: 'POST', headers: internalHeaders(deps.env, { 'content-type': 'application/json', accept: 'application/json', ...traceHeadersOf(ctx.headers) }), body })), deps.env);
          const envelope = (await res.json().catch(() => null)) as (AskEnvelope & { subjectAnswer?: { outcome?: string; said?: string } }) | null;
          if (!envelope) { await ctx.fail([{ text: `the ask answered ${res.status} with no envelope` }]); return; }
          await ctx.artifact({ name: SUBJECT_ANSWER_ARTIFACT, parts: [{ data: envelope }] });
          const outcome = envelope.subjectAnswer?.outcome ?? (envelope.reply?.kind === 'answer' ? 'answer' : envelope.ok === false ? 'error' : 'refused');
          const said = envelope.subjectAnswer?.said || envelope.reply?.text || envelope.reply?.summary || envelope.error || '';
          if (outcome === 'answer') { await ctx.complete([{ text: said || 'Answered.' }]); return; }
          if (outcome === 'needs') { await ctx.inputRequired([{ text: said || 'More is needed.' }]); return; }
          if (outcome === 'error') { await ctx.fail([{ text: said || `the ask answered ${res.status}` }]); return; }
          await ctx.reject([{ text: said || 'Refused.' }]);
          return;
        }
        const data = partsData(ctx.message.parts);
        // Whose conversation this is, so a later `GetTask` from somebody else does not read it.
        if (ctx.principal?.agent) ctx.task.metadata = { ...(ctx.task.metadata ?? {}), asker: ctx.principal.agent };
        const runRef = typeof ctx.task.metadata?.runRef === 'string' ? ctx.task.metadata.runRef : undefined;
        const promptStep = typeof ctx.task.metadata?.promptStepRef === 'string' ? ctx.task.metadata.promptStepRef : undefined;
        if (!message && !data) { await ctx.reject([{ text: 'Say what you would like this agent to do — the message carried no text.' }]); return; }
        // A continuation answers the parked prompt: text as the message, a data part as the supplied answer.
        const supplied: SuppliedInputV1[] | undefined = runRef && promptStep && data ? [{ stepRef: promptStep, data }] : undefined;
        const body = JSON.stringify({ session, addressee: agent, ...(message ? { message } : {}), ...(runRef ? { runRef } : {}), ...(supplied ? { supplied } : {}) });
        await ctx.working();
        const res = await deps.appFetch(markInWorker(new Request(`https://${host}/harness/ask`, { method: 'POST', headers: internalHeaders(deps.env, { 'content-type': 'application/json', accept: 'application/json', ...traceHeadersOf(ctx.headers) }), body })), deps.env);
        const env = (await res.json().catch(() => null)) as AskEnvelope | null;
        if (!env || env.ok === false || !env.reply) { await ctx.fail([{ text: [env?.error ?? `the ask answered ${res.status}`, env?.detail].filter(Boolean).join(': ') }]); return; }
        const r = env.reply;
        ctx.task.metadata = { ...(ctx.task.metadata ?? {}), ...(r.runRef ? { runRef: r.runRef } : {}), ...(r.prompt?.stepRef ? { promptStepRef: r.prompt.stepRef } : {}) };
        // Written first, for the same reason: this is a wire, not a speaker.
        const said = r.text || r.summary || env.spoken || '';
        const how = settlementForReplyKind(r.kind);
        if (r.kind === 'answer' && r.results?.length) await ctx.artifact({ name: 'results', parts: [{ data: r.results }], ...((r as { skillProvenance?: Record<string, unknown> }).skillProvenance ? { metadata: (r as { skillProvenance?: Record<string, unknown> }).skillProvenance } : {}) });
        if (r.kind === 'done') await ctx.artifact({ name: 'receipt', parts: [{ data: { effects: r.effects ?? null, receipt: r.receipt ?? null } }] });
        switch (how) {
          case 'completed': await settleTask(ctx, how, [{ text: said || (r.kind === 'answer' || r.kind === 'done' ? 'Done.' : `Reply: ${r.kind ?? 'unknown'}`) }]); return;
          case 'input-required': await settleTask(ctx, how, [{ text: r.prompt?.prompt ?? said ?? 'More is needed.' }, { data: r.prompt ?? {} }]); return;
          // The mandate the plan needs, for the caller to have signed and present on the next message.
          // The surface parks; it never signs (spec 372 §0).
          case 'auth-required': await settleTask(ctx, how, [{ text: said || 'This needs a mandate you have not presented.' }, { data: { requirement: r.requirement ?? null, runRef: r.runRef ?? null } }]); return;
          case 'rejected': await settleTask(ctx, how, [{ text: said || 'Refused.' }]); return;
          case 'failed': await settleTask(ctx, how, [{ text: said || env.error || 'Failed.' }]); return;
        }
      },
    },
  });
  return server;
}
