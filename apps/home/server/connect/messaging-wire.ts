// POST/GET /connect/messaging-wire — the person's MESSAGING SESSION WIRE (spec 341 Wave 4b).
//
//   GET  → { ok, sessionKey, wirePresent, expiresAt? }   what the client needs to decide whether to mint
//   POST { wire, recipients } → { ok }                    store a wire the PERSON signed
//   DELETE → { ok }                                       drop it (revocation is on-chain; this is local)
//
// WHY THE HOME STORES IT. `session-wire.ts` states the rule: "the wire is stored by the RUNTIME; no raw
// key ever rests there". The Home is the runtime that will use this wire to deliver on the person's
// behalf, so it holds the delegation — which is an authority artifact, not a secret. It is signed, it
// is scoped to named skills and named targets, it expires, and it is revocable on-chain at any time.
//
// WHY THE CLIENT SIGNS. The wire's delegator is the PERSON, so it must be signed by the person's own
// custody credential. `signHashFor(via)` routes that to WebAuthn / the injected provider / KMS — the
// first two live in the browser. So the client mints and signs; the Home validates and stores. The
// Home never sees a credential, which is the property that made this design possible at all (§5.1a).
//
// THE VALIDATION IS THE POINT. A Home that stored whatever it was handed would let a caller install a
// wire delegating to a key IT controls, and every downstream gate would verify that wire perfectly —
// because it IS perfectly valid, just not to us. So the delegate is checked against the deployment's
// own interactions session key, and the delegator against the AUTHENTICATED person. Neither is taken
// from the request body.

import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import type { Address } from '@agenticprimitives/types';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { callInteractions } from './channels';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const json = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

const KEY = (person: string): string => `messaging-wire:${person.toLowerCase()}`;

/** The authenticated person, or null. Session only — this endpoint installs authority for a person, so
 *  a relying-app id_token is deliberately NOT accepted: the ceremony belongs at the Home. */
async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, {
    keys,
    expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso',
    expectedIss: ownIssuer(request, env),
  });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** The deployment's interactions session key — read from the DO, never from the request. */
async function sessionKeyFor(env: FnContext['env'], person: string): Promise<string | null> {
  const r = await callInteractions(env, person, 'routingStatus', {}).catch(() => null);
  const k = r?.body?.sessionKey as string | undefined;
  return typeof k === 'string' && /^0x[0-9a-fA-F]{40}$/.test(k) ? k.toLowerCase() : null;
}

interface StoredWire {
  wire: { delegator?: string; delegate?: string; signature?: string; caveats?: unknown[] };
  recipients: string[];
  storedAt: string;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, request, 401);
  const raw = await env.AUTH_CODES.get(KEY(person));
  const stored = raw ? (JSON.parse(raw) as StoredWire) : null;
  return json(
    {
      ok: true,
      sessionKey: await sessionKeyFor(env, person),
      wirePresent: Boolean(stored),
      recipients: stored?.recipients ?? [],
    },
    request,
  );
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { wire?: StoredWire['wire']; recipients?: string[] }
    | null;
  const wire = body?.wire;
  if (!wire || typeof wire !== 'object') return json({ error: 'wire required' }, request, 400);

  // ── The three checks that make storing this safe ──────────────────────────────────────────────
  // 1. The wire must speak for the AUTHENTICATED person, not whoever the body names.
  if ((wire.delegator ?? '').toLowerCase() !== person) {
    return json({ error: 'wire delegator must be the authenticated person' }, request, 403);
  }
  // 2. It must delegate to THIS deployment's session key. Without this, a caller could install a wire
  //    delegating to a key they control — perfectly valid, and valid to the wrong party.
  const expected = await sessionKeyFor(env, person);
  if (!expected) {
    return json({ error: 'interactions session key is not provisioned on this deployment' }, request, 409);
  }
  if ((wire.delegate ?? '').toLowerCase() !== expected) {
    return json({ error: 'wire delegate must be this deployment’s interactions session key' }, request, 403);
  }
  // 3. An unsigned wire is not a weaker wire; it is not a wire. The gate would reject it later —
  //    rejecting here keeps the error next to its cause.
  if (!wire.signature || wire.signature === '0x') {
    return json({ error: 'wire is not signed' }, request, 400);
  }
  if (!Array.isArray(wire.caveats) || wire.caveats.length === 0) {
    // No caveats means no timestamp, no target pin and no method pin — an unbounded standing
    // authority, which is precisely what this replaces.
    return json({ error: 'wire must carry its caveats (window, targets, methods)' }, request, 400);
  }

  const recipients = (body?.recipients ?? [])
    .filter((r) => typeof r === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r))
    .map((r) => r.toLowerCase());

  const stored: StoredWire = { wire, recipients, storedAt: new Date().toISOString() };
  await env.AUTH_CODES.put(KEY(person), JSON.stringify(stored));
  return json({ ok: true, recipients }, request);
};

export const onRequestDelete = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, request, 401);
  // Local removal only. REAL revocation is on-chain and kills the wire at every gate immediately;
  // deleting our copy just stops us using it, and the distinction matters: a caller who deletes here
  // has not revoked anything.
  await env.AUTH_CODES.put(KEY(person), '', { expirationTtl: 60 });
  return json({ ok: true, note: 'local copy dropped — on-chain revocation is separate' }, request);
};
