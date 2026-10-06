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
 *  principal's own credential — the Home session the run runs under, handed in as `session`, which the
 *  Home turns into an id_token for that session's own agent (`/connect/session-token`). Demo estate:
 *  `demo-signin { client_id: <client>, as: <principal> }`. `null` ⇒ the step is REFUSED (never a silent
 *  success). */
export type ExecutorSessionSeam = (principal: Address, client: string, session?: string) => Promise<string | null>;

/**
 * The Home-backed seam, in its two bindings and in this order:
 *   1. PRODUCTION — the run's own session: `POST /connect/session-token { client_id, as: principal }` with
 *      the session as the bearer. The Home mints for the session's OWN agent only; a run whose principal
 *      is someone else gets no token here (self-acting, §6).
 *   2. DEMO — `POST /connect/demo-signin { client_id, as: principal }`: the Home resolves a seeded
 *      custodian for the principal and mints acting as them. Reached only when (1) gave nothing — a
 *      demo persona has no session of its own in an unattended run.
 * `null` when neither binds — the invoker refuses the step.
 */
/**
 * THE HOME ORIGIN THE RUNTIME CALLS, from the estate's ALLOWED_ORIGINS. The list names the Home's apex AND its `www`
 * (both are browser origins the runtime must admit); only one of them SERVES. On faithnet the apex answers every POST
 * with a 308 to `www`, and a fetch that follows a cross-origin redirect drops the Authorization header — so a seam
 * call to the apex arrived at `www` with no bearer and every executor-invoke refused "could not obtain a session"
 * (seen live 2026-10-06). Prefer the `www` form when the list has it; a wildcard (`https://*.faithnet.me`) is never
 * an origin to call. Null when nothing qualifies.
 */
export function pickHomeOrigin(allowedOrigins: string | undefined): string | null {
  const all = (allowedOrigins ?? '').split(',').map((o) => o.trim()).filter((o) => /^https:\/\/[^/*]+$/.test(o) && !/localhost|127\.0\.0\.1/.test(o));
  return all.find((o) => /^https:\/\/www\./.test(o)) ?? all[0] ?? null;
}

export function homeSessionSeam(opts: { homeOrigin: string | null; fetch?: typeof fetch; userAgent?: string }): ExecutorSessionSeam {
  const f = opts.fetch ?? fetch;
  const ua = opts.userAgent ?? 'agenticprimitives-a2a/1.0';
  const home = opts.homeOrigin;
  const read = async (r: Response | null): Promise<string | null> => {
    if (!r || !r.ok) return null;
    const b = (await r.json().catch(() => ({}))) as { id_token?: string; homeSession?: string; session?: string };
    return b.id_token ?? b.homeSession ?? b.session ?? null;
  };
  return async (principal, client, session) => {
    if (!home) return null;
    if (session) {
      const r = await f(`${home}/connect/session-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session}`, origin: home, 'user-agent': ua },
        body: JSON.stringify({ client_id: client, as: principal }),
      }).catch(() => null);
      const tok = await read(r);
      if (tok) return tok;
    }
    const r = await f(`${home}/connect/demo-signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: home, 'user-agent': ua },
      body: JSON.stringify({ as: principal, client_id: client }),
    }).catch(() => null);
    return read(r);
  };
}

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
