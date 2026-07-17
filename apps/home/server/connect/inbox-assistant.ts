// /connect/inbox-assistant — the owner's auto-reply assistant controls (spec 328 §6).
//
// PROXY to the PERSON's own InteractionsDO on demo-a2a (the spec-322 execution point), which owns
// the self gate (session SA === principal), the name capture, the vault records, and the audit.
// This route keeps ONLY session extraction + pass-through — the same posture as /connect/channels
// for the org assistant (spec 327). STRICTLY the person's own inbox: no `?agent=` managed-inbox
// scoping here (spec 328 §10 — org 1:1 mail stays human-triaged).
//
//   GET                                   → { ok, assistant, skill }
//   POST { action:'enable', displayName? }
//   POST { action:'disable' }
//   POST { action:'skillPut', markdown }
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { callInteractions } from './channels';

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

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const r = await callInteractions(env, who.person, 'inbox.assistantGet', { session: who.token });
  return jsonCors(r.body, request, r.status);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; displayName?: string; markdown?: string }
    | null;
  if (body?.action === 'enable' || body?.action === 'disable') {
    const r = await callInteractions(env, who.person, body.action === 'enable' ? 'inbox.assistantEnable' : 'inbox.assistantDisable', {
      session: who.token,
      ...(body.action === 'enable' && body.displayName ? { displayName: body.displayName } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  if (body?.action === 'skillPut') {
    const r = await callInteractions(env, who.person, 'inbox.assistantSkill.put', {
      session: who.token, markdown: body.markdown ?? '',
    });
    return jsonCors(r.body, request, r.status);
  }
  return jsonCors({ error: 'unknown action' }, request, 400);
};
