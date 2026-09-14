// Spec 400 W4 — CONNECT GOOGLE CALENDAR at the Home, as the person's own connector under the delegation model.
//
//   POST /connect/connector/calendar  { action: 'start', write?: boolean, returnTo? }   → { url } to send the browser to
//   POST /connect/connector/calendar  { action: 'status' | 'disconnect' }
//
// `start` begins an INCREMENTAL Google authorization for the signed-in person: the calendar scope (read, or read+events
// when she asks to let her agent add events), `access_type=offline` for a refresh token, `prompt=consent` so Google
// issues one, `include_granted_scopes` so a Google-custodied home keeps what it had. The stash names the PERSON (her
// Home session) — an email home may connect a different Google account, so the token is never keyed by (iss,sub). The
// callback (`/oidc/google/callback`, `purpose: 'calendar'`) hands the tokens to the agent runtime over the custody
// bridge, which envelope-encrypts them under her SA; the Home never keeps them.
import { beginLogin } from '@agenticprimitives/connect-auth/google';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, json, type FnContext } from '../_lib/server-broker';
import { signBridgeCall } from '../_lib/bridge-hmac';

export const CALENDAR_SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
export const CALENDAR_SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';

async function personFromSession(env: FnContext['env'], request: Request): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
  return person ? { person, token } : null;
}

export async function connectorBridge(env: FnContext['env'], audience: 'custody.connector.store' | 'custody.connector.status' | 'custody.connector.disconnect', payload: unknown): Promise<{ status: number; body: unknown }> {
  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) return { status: 503, body: { ok: false, error: 'custody_bridge_not_configured' } };
  const path = audience === 'custody.connector.store' ? '/custody/connector/store-token' : audience === 'custody.connector.status' ? '/custody/connector/status' : '/custody/connector/disconnect';
  const envelope = await signBridgeCall({ secret: env.A2A_CUSTODY_BRIDGE_SECRET, audience, payload });
  const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: envelope.headers, body: envelope.body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFromSession(env, request);
  if (!who) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = (await request.json().catch(() => null)) as { action?: string; write?: boolean; returnTo?: string } | null;
  if (body?.action === 'status') { const r = await connectorBridge(env, 'custody.connector.status', { person: who.person, provider: 'google-calendar' }); return json(r.body, r.status); }
  if (body?.action === 'disconnect') { const r = await connectorBridge(env, 'custody.connector.disconnect', { person: who.person, provider: 'google-calendar' }); return json(r.body, r.status); }
  if (body?.action !== 'start') return json({ ok: false, error: 'action: start | status | disconnect' }, 400);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) return json({ ok: false, error: 'Google is not configured on this Home' }, 503);
  const scope = body.write ? `openid email ${CALENDAR_SCOPE_READ} ${CALENDAR_SCOPE_EVENTS}` : `openid email ${CALENDAR_SCOPE_READ}`;
  const { authUrl, codeVerifier, state, nonce } = beginLogin({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: env.GOOGLE_REDIRECT_URI, scope, prompt: 'consent', accessType: 'offline', includeGrantedScopes: true });
  const returnTo = typeof body.returnTo === 'string' && body.returnTo.startsWith('/') ? body.returnTo : '/settings/connections';
  await env.AUTH_CODES.put(`oidc:${state}`, JSON.stringify({ codeVerifier, nonce, aud: env.DEMO_SSO_AUD ?? 'demo-sso', purpose: 'calendar', person: who.person, returnTo }), { expirationTtl: 600 });
  return json({ ok: true, url: authUrl });
};
