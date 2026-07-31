// /connect/archetype-grants — a host org's opt-in to being dispatched to for its archetypes.
//
// The AUTHORITY is the HOST-signed dispatch delegation (host org → calling org, allowedTargets =
// [host], allowedMethods = one selector PER ARCHETYPE, 90-day timestamp). Built by
// `issueArchetypeDispatchDelegation`; signed CLIENT-SIDE by the host's custodian, exactly as
// consultability is signed by the member — this route never holds a key and never mints.
//
// DIRECTION, because it is the opposite of intuition and this is the endpoint where a caller would
// most plausibly try to grant themselves: the DELEGATOR is the org that HOSTS the archetypes and
// will spend its agent budget. This route refuses anything else rather than fixing it up. A grant
// minted the other way round would be a caller authorizing itself (ADR-0041), and the host's A2A
// gate would reject it anyway — better to fail here, where the reason is legible.
//
// Verification, custody and audit belong to the CALLING org's InteractionsDO (`archetype.grantPut`):
// shape, ERC-1271 against the host, unrevoked on-chain, fail-closed. This route is session
// extraction and a fail-closed pass-through, like consultability one relationship over.
//
//   POST { action:'grant',  caller, delegation, archetypes[] } → { ok, grantedAt, archetypes }
//   POST { action:'status', caller, host }                     → { ok, granted, grantedAt, archetypes }
//   POST { action:'forget', caller, host }                     → { ok, forgotten }
//
// `forget` is deliberately not called revoke: it drops the caller's stored copy so it stops
// presenting a wire it no longer intends to use. WITHDRAWING AUTHORITY IS THE HOST'S ON-CHAIN
// REVOCATION — a button that looked like revocation but only forgot locally would be the dangerous
// kind of wrong.
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import type { DelegationWire } from '../../src/lib/delegation';
import { callInteractions, stewardWireFor } from './channels';

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

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

const isAddr = (s: string): boolean => /^0x[0-9a-f]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; caller?: string; host?: string; delegation?: DelegationWire; archetypes?: string[] }
    | null;

  // The CALLING org is the one whose DO stores the grant — it is the party that will present it.
  const caller = (body?.caller ?? '').toLowerCase();
  if (!isAddr(caller)) return jsonCors({ error: 'caller (the dispatching org SA) required' }, request, 400);

  // THE STEWARD WIRE, which every sibling endpoint resolves and this one did not. The DO gates
  // `archetype.*` on `isSteward(caller, session, stewardship)`; without the wire that check has
  // nothing to verify against and refuses a steward who genuinely is one — "only a steward of this
  // organization may manage its archetype dispatch grants", to the person who stewards it.
  const stewardship = await stewardWireFor(env, who.person, caller, who.token);

  if (body?.action === 'status' || body?.action === 'forget') {
    const host = (body?.host ?? '').toLowerCase();
    if (!isAddr(host)) return jsonCors({ error: 'host (SA address) required' }, request, 400);
    const op = body.action === 'status' ? 'archetype.grantStatus' : 'archetype.grantRevoke';
    const r = await callInteractions(env, caller, op, { session: who.token, host, ...(stewardship ? { stewardship } : {}) });
    return jsonCors(r.body, request, r.status);
  }

  if (body?.action !== 'grant') return jsonCors({ error: 'unknown action' }, request, 400);

  const d = body.delegation;
  if (!d?.delegator || !d?.delegate || !d?.signature) {
    return jsonCors({ error: 'signed archetype dispatch delegation required' }, request, 400);
  }
  // Refused, never fixed up: the delegator must be the host being dispatched TO, and the delegate
  // must be the caller storing it. Silently correcting either would mean storing a grant nobody
  // signed for the relationship it claims.
  if (d.delegate.toLowerCase() !== caller) {
    return jsonCors({ error: 'delegation delegate must be the calling organization' }, request, 403);
  }
  if (d.delegator.toLowerCase() === caller) {
    return jsonCors({ error: 'self-dispatch needs no grant — host and caller are the same org' }, request, 400);
  }

  const archetypes = Array.isArray(body.archetypes)
    ? body.archetypes.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)
    : [];

  // The calling org's DO owns verification (shape, ERC-1271 against the HOST, unrevoked on-chain)
  // and custody. Fail-closed pass-through — its refusal is the answer, unaltered.
  const r = await callInteractions(env, caller, 'archetype.grantPut', {
    session: who.token, delegation: d, archetypes, ...(stewardship ? { stewardship } : {}),
  });
  return jsonCors(r.body, request, r.status);
};
