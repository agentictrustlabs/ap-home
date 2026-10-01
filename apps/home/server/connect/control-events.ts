// /connect/control-events — the Home's control-plane timeline (spec 310 W4).
//
//   GET  → { events: HomeControlEventV1[] }        (session required)
//   POST { eventType, refs? } → { ok: true }        (session required)
//
// Every row is durable-audit-backed: an AuditEvent is appended FIRST (same KV
// audit log the inbox admitters use) and the control row carries its id as
// `auditRef`. If the audit append fails the event is not recorded (spec 291).
// Server-side flows (inbox decisions, manifest publish) append through
// `appendControlEvent` directly; UI flows (revoke, agent-added) POST here.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import type { HomeControlEventV1 } from '@agenticprimitives/home';
import type { Address } from '@agenticprimitives/types';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { homeCaip10 } from '../../src/home/manifest';
import { homeAuditSink } from '../../src/home/inbox-data';

const KEY = (person: string): string => `home-control:${person.toLowerCase()}`;

const EVENT_TYPES: readonly HomeControlEventV1['eventType'][] = [
  'grant-issued',
  'grant-revoked',
  'agent-added',
  'agent-disabled',
  'credential-issued',
  'credential-received',
  'inbox-decision',
  'home-rotated',
  'credential-added',
  'credential-retired',
  'channel-linked',
  'channel-unlinked',
];

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** Audit-then-append (fail-closed: no audit row ⇒ no timeline row). */
export async function appendControlEvent(
  env: FnContext['env'],
  person: Address,
  eventType: HomeControlEventV1['eventType'],
  refs: HomeControlEventV1['refs'] = [],
  /** The person's OWN broker session. Optional only because the parameter was added under existing
   *  callers; every one of them turned out to have the token in scope, which is why the bridge branch
   *  could go. Absent ⇒ no vault append (best-effort, as before), never a fall back to a secret. */
  session?: string,
): Promise<void> {
  const auditId = globalThis.crypto.randomUUID();
  await homeAuditSink(env.AUTH_CODES, person).write({
    id: auditId,
    timestamp: new Date().toISOString(),
    action: 'home.control-event',
    outcome: 'success',
    actor: { type: 'user', id: person },
    subject: { type: 'home-control', id: eventType },
  });
  const row: HomeControlEventV1 = {
    type: 'ap.home.control-event.v1',
    homeId: `home_${person.toLowerCase()}`,
    actor: homeCaip10(person),
    eventType,
    at: new Date().toISOString(),
    refs,
    auditRef: auditId,
  };
  // spec 323 W2.3 — the AUTHORITATIVE timeline is the person's vault `control-events.data` (their
  // InteractionsDO). Server flows have no person bearer, so the append rides the SEC-010 bridge
  // (audience interactions.controlevents.append), same rationale as the W3f inbox ops. The KV copy
  // is a rebuildable cache. Best-effort: a person whose interactions plane isn't enabled keeps the
  // KV copy until their ceremony re-syncs.
  // spec 341 §1 — the person's own session, and ONLY that. The bridge branch is gone: every caller
  // turned out to hold the caller's token already (`home-manifest`, `library`, `directory`), so the
  // secret path was unreachable — and an unreachable fallback is a second mechanism waiting to be
  // routed to (ADR-0013). No session ⇒ the vault append is skipped and the KV copy stands, which is
  // the same best-effort outcome this always had.
  if (session) {
    const { callInteractions } = await import('./channels');
    await callInteractions(env, person, 'controlevents.append', { event: row, session }).catch(() => null);
  }
  const raw = await env.AUTH_CODES.get(KEY(person));
  const rows = raw ? (JSON.parse(raw) as HomeControlEventV1[]) : [];
  rows.push(row);
  await env.AUTH_CODES.put(KEY(person), JSON.stringify(rows.slice(-200)));
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const bearer = (request.headers.get('authorization') ?? '').slice(7);
  // Authoritative read from the person's vault (session-gated record.get); reconcile the KV cache.
  // Empty/plane-not-enabled falls to the cache (an answer, ADR-0013 — not a second mechanism).
  const { readCapabilityRecord } = await import('../lib/capability-record');
  const authoritative = await readCapabilityRecord<HomeControlEventV1[]>(env, person, bearer, 'control-events.data');
  if (Array.isArray(authoritative)) {
    await env.AUTH_CODES.put(KEY(person), JSON.stringify(authoritative));
    return jsonCors({ events: [...authoritative].reverse() }, request);
  }
  const raw = await env.AUTH_CODES.get(KEY(person));
  const events = raw ? (JSON.parse(raw) as HomeControlEventV1[]) : [];
  return jsonCors({ events: events.reverse() }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { eventType?: HomeControlEventV1['eventType']; refs?: HomeControlEventV1['refs'] }
    | null;
  if (!body?.eventType || !EVENT_TYPES.includes(body.eventType)) {
    return jsonCors({ error: 'valid eventType required' }, request, 400);
  }
  const refs = Array.isArray(body.refs) ? body.refs.slice(0, 8) : [];
  // The person's own session authorizes their own timeline append (spec 341 §1) — no shared secret.
  await appendControlEvent(env, person as Address, body.eventType, refs, (request.headers.get('authorization') ?? '').slice(7));
  return jsonCors({ ok: true }, request);
};
