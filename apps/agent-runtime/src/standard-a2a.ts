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
// Conversational task rows are a per-isolate projection (in memory); a delegated task lives in the object
// that owns it. Nothing a person cannot rebuild is in either (ADR-0055).
import type { Address } from 'viem';
import {
  AP_DELEGATED_TASK_EXTENSION, DELEGATED_TASK_CARD_EXTENSION, createStandardA2aServer, createMemoryTaskStore,
  createMemoryPushStore, isPartyToDelegatedTask, readDelegatedTask, sessionWirePrincipal,
  type AgentCardV1, type ExecutionContext, type MessageV1, type PartV1, type Principal, type StandardServer,
  type SessionWirePrincipalDeps, type StandardTaskStore, type TaskV1,
} from '@agenticprimitives/a2a/standard';
import type { SuppliedInputV1 } from '@agenticprimitives/orchestration';
import { internalHeaders, type InternalMarkerEnv } from './internal-marker.js';

/** The runtime mints 32-byte hex task ids; this server's own conversational tasks are uuids. That is how a
 *  read knows which side holds it — the shape is minted, not guessed (`newTaskId` in the DO). */
const isRuntimeTaskId = (id: unknown): boolean => typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id);

/**
 * The 1.0 fields a live card needs on top of what the Worker already builds: an interface with a protocol
 * version, input/output modes, skills with names, and the bearer scheme this surface admits. Additive —
 * every field the card carried stays; a released card (347 §8) is served byte-for-byte and untouched.
 */
export function withStandardCardFields(live: Record<string, unknown>, opts: { messageUrl: string }): Record<string, unknown> {
  const skills = (Array.isArray(live.skills) ? live.skills : []) as Array<{ id: string; name?: string; description?: string; tags?: string[] }>;
  const caps = (live.capabilities && typeof live.capabilities === 'object' ? live.capabilities : {}) as Record<string, unknown>;
  return {
    ...live,
    protocolVersion: '1.0',
    supportedInterfaces: [{ url: opts.messageUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    // Honest flags: the standard server mounted here streams (SSE) and delivers push; the profile's DO
    // runtime does neither — the flags describe the surface a 1.0 client reaches by these methods.
    capabilities: {
      ...caps, streaming: true, pushNotifications: true, extendedAgentCard: false,
      // The card SAYS how to authorize a task, so a peer learns it before calling rather than by failing.
      extensions: [
        ...((caps.extensions as Array<{ uri: string }> | undefined) ?? []).filter((e) => e.uri !== AP_DELEGATED_TASK_EXTENSION),
        { ...DELEGATED_TASK_CARD_EXTENSION },
      ],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: skills.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? s.name ?? s.id, tags: s.tags ?? [] })),
    securitySchemes: { ...((live.securitySchemes as Record<string, unknown> | undefined) ?? {}), homeSession: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'home-session', description: 'A Home session presented as a bearer names the asking person; it grants nothing (spec 372 §0).' } } },
    securityRequirements: [{ schemes: { homeSession: { list: [] } } }],
  };
}

export interface StandardMountDeps {
  env: InternalMarkerEnv & Record<string, unknown>;
  /** The Worker's own app, so the ask runs in-process (a Worker cannot fetch its own hostname). Called with
   *  THIS request's execution context — Hono refuses `c.executionCtx` without one, and the ask route uses it. */
  appFetch: (request: Request, env: unknown) => Promise<Response>;
  /** Verifies a Home session token → the person's SA. */
  verifySession: (token: string) => Promise<{ ok: true; sa: Address } | { ok: false; status: number; error: string }>;
  /** Spec 372 S3c — the chain checks behind an AGENT's session wire. Absent ⇒ only people are admitted. */
  wire?: Pick<SessionWirePrincipalDeps, 'enforcers' | 'verifyDelegationSig' | 'isRevoked'>;
  /** Spec 372 S3c — spend a caller's assertion once, at the addressed agent's own object. */
  claimAssertion?: (agent: Address, digest: string, expiresAtMs: number) => Promise<boolean>;
  /** Spec 372 S4 — forward a 1.0 request to the agent's own object, where the delegation-authorized
   *  runtime lives. Returns the JSON-RPC response verbatim. */
  delegatedRpc?: (agent: Address, rpc: unknown, principal: Principal | null) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  /** Spec 372 S3c — an agent asking as itself: no session, no mandate, its own standing. */
  askAsAgent?: (input: { agent: Address; addressee: Address; ask: string; runRef: string }) => Promise<{
    reply: { kind: string; text?: string; prompt?: { kind: string; prompt: string; stepRef: string }; error?: string };
    spoken: string;
  }>;
}

interface AskEnvelope {
  ok?: boolean; error?: string; detail?: string; spoken?: string;
  reply?: { kind?: string; runRef?: string; text?: string; summary?: string; results?: Array<{ toolId: string; result: unknown }>; prompt?: { kind?: string; stepRef?: string; prompt?: string; fields?: Array<{ name?: string }> }; requirement?: unknown; effects?: unknown; receipt?: unknown };
}

const textOf = (parts: PartV1[]): string => parts.map((p) => (typeof p.text === 'string' ? p.text : typeof p.data === 'string' ? p.data : '')).filter(Boolean).join('\n').trim();
const dataOf = (parts: PartV1[]): Record<string, unknown> | null => { const d = parts.find((p) => p.data && typeof p.data === 'object' && !Array.isArray(p.data)); return d ? (d.data as Record<string, unknown>) : null; };

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
  // ONE TASK VIEW over two stores (spec 372 S4): a 32-byte hex id can only be the runtime's, so a read
  // asks the object that owns it; anything else is a conversation this server made. A caller cannot tell,
  // and must not have to.
  const tasks: StandardTaskStore = deps.delegatedRpc
    ? {
        async get(id) {
          if (!isRuntimeTaskId(id)) return st.tasks.get(id);
          const r = await deps.delegatedRpc!(agent, { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id } }, null).catch(() => null);
          return (r?.result as TaskV1 | undefined) ?? null;
        },
        put: (t) => st.tasks.put(t),
        async all() {
          const own = await st.tasks.all();
          const r = await deps.delegatedRpc!(agent, { jsonrpc: '2.0', id: 1, method: 'ListTasks', params: {} }, null).catch(() => null);
          const theirs = ((r?.result as { tasks?: TaskV1[] } | undefined)?.tasks ?? []);
          return [...theirs, ...own];
        },
      }
    : st.tasks;

  const server = createStandardA2aServer({
    card,
    tasks,
    push: st.push,
    // A delegated task is the runtime's — it keeps its id, and this server never makes a second one.
    ...(deps.delegatedRpc ? {
      beforeSend: async ({ message, configuration }, principal) => {
        const ext = readDelegatedTask(message as MessageV1);
        if (ext === null) return null;
        const r = await deps.delegatedRpc!(agent, {
          jsonrpc: '2.0', id: 1, method: 'SendMessage',
          params: { message, ...(configuration ? { configuration } : {}) },
        }, principal);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, name: 'A2aError' });
        return (r.result as { task?: TaskV1; message?: MessageV1 }) ?? null;
      },
      onCancel: async (task, principal) => {
        if (!isRuntimeTaskId(task.id)) return null;
        const r = await deps.delegatedRpc!(agent, { jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: task.id } }, principal);
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, name: 'A2aError' });
        return (r.result as TaskV1) ?? null;
      },
    } : {}),
    // A delegated task is visible to its parties; a conversation, to whoever had it.
    canSeeTask: (task, principal) => {
      const delegated = (task.metadata as Record<string, unknown> | undefined)?.[AP_DELEGATED_TASK_EXTENSION] !== undefined;
      if (delegated) return isPartyToDelegatedTask(task, principal?.agent);
      const asker = (task.metadata as { asker?: string } | undefined)?.asker;
      return !asker || asker === principal?.agent;
    },
    // TWO SCHEMES, ONE MECHANISM EACH (ADR-0013). `Bearer` is a PERSON's Home session; `A2A-Session` is an
    // AGENT's session wire, verified on chain per request (spec 372 S3c). The scheme token selects which
    // runs — neither is ever tried because the other failed, and each fails closed on its own terms.
    principal: async (request): Promise<Principal | null> => {
      const auth = request.headers.get('authorization') ?? '';
      if (/^A2A-Session\s/i.test(auth)) return byWire ? byWire(request) : null;
      const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
      if (!token) return null;
      const who = await deps.verifySession(token).catch(() => null);
      return who && who.ok ? { agent: who.sa.toLowerCase(), session: token } : null;
    },
    executor: {
      execute: async (ctx: ExecutionContext) => {
        const session = String(ctx.principal?.session ?? '');
        const message = textOf(ctx.message.parts);
        // AN AGENT ASKING AS ITSELF (spec 372 S3c). It has no person's session and is given none: the run
        // is the same one a trigger fires — no mandate presented, reads bounded to what this agent's own
        // records say to that asker, an act suspending as AUTH_REQUIRED with what it would need.
        if (!session && ctx.principal?.kind === 'agent' && deps.askAsAgent) {
          if (!message) { await ctx.reject([{ text: 'Say what you would like this agent to do — the message carried no text.' }]); return; }
          await ctx.working();
          const asked = await deps.askAsAgent({ agent: ctx.principal.agent as Address, addressee: agent, ask: message, runRef: `svc-${ctx.task.id}` });
          const words = asked.spoken || asked.reply.text || '';
          if (asked.reply.kind === 'answer' || asked.reply.kind === 'done') { await ctx.complete([{ text: words || 'Done.' }]); return; }
          if (asked.reply.kind === 'prompt') { await ctx.inputRequired([{ text: asked.reply.prompt?.prompt ?? words }, { data: asked.reply.prompt ?? {} }]); return; }
          if (asked.reply.kind === 'authority_required') { await ctx.authRequired([{ text: words || 'This needs a mandate no one has granted.' }]); return; }
          await ctx.reject([{ text: words || asked.reply.error || 'Refused.' }]);
          return;
        }
        const data = dataOf(ctx.message.parts);
        // Whose conversation this is, so a later `GetTask` from somebody else does not read it.
        if (ctx.principal?.agent) ctx.task.metadata = { ...(ctx.task.metadata ?? {}), asker: ctx.principal.agent };
        const runRef = typeof ctx.task.metadata?.runRef === 'string' ? ctx.task.metadata.runRef : undefined;
        const promptStep = typeof ctx.task.metadata?.promptStepRef === 'string' ? ctx.task.metadata.promptStepRef : undefined;
        if (!message && !data) { await ctx.reject([{ text: 'Say what you would like this agent to do — the message carried no text.' }]); return; }
        // A continuation answers the parked prompt: text as the message, a data part as the supplied answer.
        const supplied: SuppliedInputV1[] | undefined = runRef && promptStep && data ? [{ stepRef: promptStep, data }] : undefined;
        const body = JSON.stringify({ session, addressee: agent, ...(message ? { message } : {}), ...(runRef ? { runRef } : {}), ...(supplied ? { supplied } : {}) });
        await ctx.working();
        const res = await deps.appFetch(new Request(`https://${host}/harness/ask`, { method: 'POST', headers: internalHeaders(deps.env, { 'content-type': 'application/json', accept: 'application/json' }), body }), deps.env);
        const env = (await res.json().catch(() => null)) as AskEnvelope | null;
        if (!env || env.ok === false || !env.reply) { await ctx.fail([{ text: [env?.error ?? `the ask answered ${res.status}`, env?.detail].filter(Boolean).join(': ') }]); return; }
        const r = env.reply;
        ctx.task.metadata = { ...(ctx.task.metadata ?? {}), ...(r.runRef ? { runRef: r.runRef } : {}), ...(r.prompt?.stepRef ? { promptStepRef: r.prompt.stepRef } : {}) };
        const said = env.spoken || r.text || r.summary || '';
        switch (r.kind) {
          case 'answer': {
            if (r.results?.length) await ctx.artifact({ name: 'results', parts: [{ data: r.results }] });
            await ctx.complete([{ text: said || 'Done.' }]);
            return;
          }
          case 'done': {
            await ctx.artifact({ name: 'receipt', parts: [{ data: { effects: r.effects ?? null, receipt: r.receipt ?? null } }] });
            await ctx.complete([{ text: said || 'Done.' }]);
            return;
          }
          case 'prompt': {
            await ctx.inputRequired([{ text: r.prompt?.prompt ?? said ?? 'More is needed.' }, { data: r.prompt ?? {} }]);
            return;
          }
          case 'authority_required': {
            // The mandate the plan needs, for the caller to have signed and present on the next message.
            // The surface parks; it never signs (spec 372 §0).
            await ctx.authRequired([{ text: said || 'This needs a mandate you have not presented.' }, { data: { requirement: r.requirement ?? null, runRef: r.runRef ?? null } }]);
            return;
          }
          case 'refused': case 'denied': {
            await ctx.reject([{ text: said || 'Refused.' }]);
            return;
          }
          default: {
            await ctx.complete([{ text: said || `Reply: ${r.kind ?? 'unknown'}` }]);
          }
        }
      },
    },
  });
  return server;
}
