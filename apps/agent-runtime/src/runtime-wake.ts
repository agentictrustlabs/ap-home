// SPEC 400 W1c — WAKING A RUNTIME MEMBER'S HOST. The Worker never polls and never speaks ACP; when a message is
// ADMITTED into a member's inbox (`internal.deliver`, the recipient's own plane) and that member's custodian has
// declared where its runtime lives, the Worker enqueues one wake and a queue consumer delivers it — to the app's
// Container binding (one instance per member, the ACP host + agent inside) or to a URL the custodian named. The
// runtime then runs ONE pass of the same loop it would run on a laptop's timer: it reads the message itself, under
// its own wire, and answers as itself; every write parks for the steward.
//
// A wake is CONFIG and a NUDGE, never content and never authority: it carries the member, the thread and the message
// id, nothing else. A stray or duplicated wake (Queues are at-least-once) costs the runtime one inbox read. The
// host declaration lives DO-local on the member's object (serving plane: if wiped, the custodian re-declares with
// `ap runtime host`; nothing is lost that was not config). The wake's outcome is kept the same way, bounded, as the
// receipt a steward (and the live gate) reads back.
import type { Env } from './index.js';
import { internalHeaders } from './internal-marker.js';

/** Where a runtime member's host lives — the Worker's wake target (mirrors `RuntimeHostV1` in runtime-member). */
export type RuntimeHostV1 = { v: 1; kind: 'container' } | { v: 1; kind: 'url'; url: string };

export interface WakeMessageV1 {
  v: 1;
  /** The member's agent address (lower-case) — the InteractionsDO / Container instance name. */
  member: string;
  memberName: string | null;
  conversationId: string;
  messageId: string;
  host: RuntimeHostV1;
  at: string;
}

export interface WakeReceiptV1 {
  v: 1;
  messageId: string;
  conversationId: string;
  host: RuntimeHostV1;
  enqueuedAt: string;
  wokeAt: string;
  /** `woken` — the host answered; `unreachable` — it did not (the runtime will see the message on its next pass). */
  outcome: 'woken' | 'unreachable';
  status: number | null;
  /** What the host reported: the turns it took (the reply's parked run ref is what the steward goes to sign). */
  turns: Array<{ messageId: string; from: string; fromName: string | null; conversationId: string; answer: string; reply: string; parkedRunRef?: string }>;
  error?: string;
}

export const RUNTIME_HOST_KEY = 'runtime.host';
export const RUNTIME_WAKES_KEY = 'runtime.wakes';
export const RUNTIME_WAKE_PREFIX = 'runtime.wake:';
export const RUNTIME_WAKES_CAP = 50;

export function parseRuntimeHost(v: unknown): RuntimeHostV1 | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as { v?: unknown; kind?: unknown; url?: unknown };
  if (h.v !== 1) return null;
  if (h.kind === 'container') return { v: 1, kind: 'container' };
  if (h.kind === 'url' && typeof h.url === 'string' && /^https?:\/\/\S+$/.test(h.url)) return { v: 1, kind: 'url', url: h.url.replace(/\/$/, '') };
  return null;
}

/** Enqueue one wake. Absent binding ⇒ nothing (the runtime polls) — said in the log, never a fallback to polling here. */
export async function enqueueRuntimeWake(env: Env, wake: Omit<WakeMessageV1, 'v' | 'at'>): Promise<boolean> {
  if (!env.RUNTIME_WAKE) { console.warn(`[runtime-wake] ${wake.memberName ?? wake.member} declares a host but RUNTIME_WAKE is unbound — not woken`); return false; }
  await env.RUNTIME_WAKE.send({ v: 1, at: new Date().toISOString(), ...wake } satisfies WakeMessageV1);
  return true;
}

/** Deliver one wake to the host and keep the receipt on the member's object. */
export async function deliverRuntimeWake(env: Env, wake: WakeMessageV1, fetchImpl: typeof fetch = fetch): Promise<WakeReceiptV1> {
  const body = JSON.stringify({ v: 1, member: wake.memberName ?? wake.member, conversationId: wake.conversationId, messageId: wake.messageId });
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
  let res: Response | null = null; let error: string | undefined;
  try {
    if (wake.host.kind === 'container') {
      if (!env.RUNTIME) throw new Error('RUNTIME (the Container binding) is unbound');
      // The Container instance is named by the member: one runtime per member, its sessions per conversation
      // surviving between wakes while it is warm.
      const stub = env.RUNTIME.get(env.RUNTIME.idFromName(wake.member));
      res = await stub.fetch(new Request('http://runtime/wake', init));
    } else {
      res = await fetchImpl(`${wake.host.url}/wake`, init);
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const out = res ? await res.json().catch(() => ({})) as { turns?: WakeReceiptV1['turns']; error?: string } : {};
  const receipt: WakeReceiptV1 = {
    v: 1, messageId: wake.messageId, conversationId: wake.conversationId, host: wake.host, enqueuedAt: wake.at, wokeAt: new Date().toISOString(),
    outcome: res?.ok ? 'woken' : 'unreachable', status: res?.status ?? null, turns: Array.isArray(out.turns) ? out.turns : [],
    ...((error ?? out.error) ? { error: error ?? out.error } : {}),
  };
  await env.INTERACTIONS.get(env.INTERACTIONS.idFromName(wake.member)).fetch(new Request(`https://do/interactions/${wake.member}/internal.runtime.wake.put`, {
    method: 'POST', headers: internalHeaders(env), body: JSON.stringify({ receipt }),
  })).catch((e: unknown) => console.warn('[runtime-wake] receipt not kept:', e instanceof Error ? e.message : String(e)));
  return receipt;
}

/** The queue consumer: every message is one wake; an unreachable host is NOT retried into a hot loop — the runtime's
 *  next pass (or the custodian's re-declaration) covers it, and the receipt says `unreachable`. */
export async function consumeRuntimeWakes(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    const wake = m.body as WakeMessageV1;
    if (!wake || wake.v !== 1 || typeof wake.member !== 'string' || !parseRuntimeHost(wake.host)) { m.ack(); continue; }
    const r = await deliverRuntimeWake(env, wake);
    console.log(`[runtime-wake] ${wake.memberName ?? wake.member} ${r.outcome}${r.status ? ` (${r.status})` : ''} for ${wake.messageId}: ${r.turns.length} turn(s)${r.error ? ` — ${r.error}` : ''}`);
    m.ack();
  }
}
