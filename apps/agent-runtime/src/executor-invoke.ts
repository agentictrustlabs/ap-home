// Spec 426 — THE ONE GENERIC INVOKER for any capability carrying an `invoke` block: "call executor E's skill S
// as me, and hand me back its receipt." It resolves the named executor to { url, client } through OPERATOR
// CONFIG (never a host in code — ADR-0021), obtains a session for the RUN'S PRINCIPAL through one injected seam,
// sends one A2A `message/send` carrying `metadata.skill = intent`, and returns the executor's receipt. Self-
// acting (v1): the session is the authority, and the invoker takes it from the PRINCIPAL — never from an arg
// (§6), which is why a contract may declare `invoke`/`selfAuthorized` without weakening a gate. It replaces every
// bespoke per-domain write tool (Field Rails was the first): a new write is a contract declaration, not a branch.
import type { ToolInvoker, ExecutorInvokeV1 } from '@agenticprimitives/orchestration';
import type { Address } from '@agenticprimitives/types';

export interface ExecutorConfigV1 {
  /** The executor's A2A base; its `/a2a` is the door. */
  url: string;
  /** The OIDC client id the principal's session is minted for. */
  client: string;
}
export type ExecutorsV1 = Record<string, ExecutorConfigV1>;

/** THE ONE SEAM (§5): an id_token for the principal, scoped to the executor's client. Production: the
 *  principal's own credential. Demo estate: `demo-signin { client_id: <client>, handle: <custodian>, as:
 *  <principal> }`. `null` ⇒ the step is REFUSED (never a silent success). */
export type ExecutorSessionSeam = (principal: Address, client: string) => Promise<string | null>;

export interface ExecutorInvokeDeps {
  executors: ExecutorsV1;
  session: ExecutorSessionSeam;
  fetch?: typeof fetch;
}

/** Parse the `EXECUTORS` operator config — a JSON map `ref → { url, client }`. Malformed or absent ⇒ `{}`
 *  (fail-closed §4: every ref then refuses; a host is never guessed). */
export function readExecutors(raw: string | undefined): ExecutorsV1 {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: ExecutorsV1 = {};
    for (const [k, v] of Object.entries(o)) {
      const e = v as { url?: unknown; client?: unknown };
      if (typeof e?.url === 'string' && typeof e?.client === 'string') out[k] = { url: e.url, client: e.client };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The invoker for ONE resolved invoke capability, acting as `principal` (the run's principal — the agent the run
 * is for). The dispatch has already matched the toolId to its `invoke` block; this performs the call.
 */
export function executorInvokeInvoker(deps: ExecutorInvokeDeps, invoke: ExecutorInvokeV1, principal: Address | undefined): ToolInvoker {
  const f = deps.fetch ?? fetch;
  return async (toolId, args) => {
    if (!principal) return { refused: `${toolId} acts as the principal, and this run has no principal` };
    const ex = deps.executors[invoke.executor];
    if (!ex?.url || !ex?.client) return { refused: `no executor is configured for "${invoke.executor}" on this deployment` };
    const goal = String(args[invoke.args.goal] ?? '').trim();
    if (!goal) return { refused: `what happened? — ${toolId} needs ${invoke.args.goal} in the actor's own words` };

    const idToken = await deps.session(principal, ex.client).catch(() => null);
    if (!idToken) return { refused: `could not obtain a session for the principal at "${invoke.executor}"` };

    const metadata: Record<string, unknown> = { skill: invoke.intent };
    for (const name of invoke.args.metadata ?? []) if (args[name] !== undefined) metadata[name] = args[name];

    const res = await f(`${ex.url.replace(/\/$/, '')}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: goal }], metadata } } }),
    }).catch((e: unknown) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) } as unknown as Response));

    const body = (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { message?: string; data?: { error?: string } } } | null;
    if (!res.ok || body?.error) {
      return { refused: body?.error?.data?.error ?? body?.error?.message ?? `${invoke.executor} refused ${toolId} (${res.status})` };
    }
    // The receipt is OPAQUE here — whatever the executor returned that identifies the write. The harness records
    // the applied capability + executor + intent + this receipt in run.provenance (W3); the caller enforces
    // apply-iff-proof (§7). No fallback on error (ADR-0013): a refusal is a refusal.
    const receipt = body?.result ?? {};
    // `invoked` names the executor + intent for provenance (spec 426 §7); the harness surfaces it + the receipt
    // on the step's `run.provenance` entry, which the caller reads for apply-iff-proof. Opaque receipt, clean result.
    return { answer: `Done — recorded with ${invoke.executor}.`, receipt, record: receipt, invoked: { executor: invoke.executor, intent: invoke.intent } };
  };
}
