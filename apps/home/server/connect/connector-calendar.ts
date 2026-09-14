// Spec 400 §5.8 / 402 W2 — CONNECT A GOOGLE ACCOUNT at the Home, as the person's own connector under the delegation model.
//
//   POST /connect/connector/<calendar|gmail|drive>  { action: 'start', write?: boolean, returnTo? }   → { url }
//   POST /connect/connector/<name>                   { action: 'status' | 'disconnect' }
//
// `start` begins an INCREMENTAL Google authorization for the signed-in person with the connector's scopes (read, or
// read + the one write the connector offers: calendar events, mail drafts), `access_type=offline` for a refresh token,
// `prompt=consent` so Google issues one, `include_granted_scopes` so a Google-custodied home keeps what it had. The
// stash names the PERSON (her Home session) — an email home may connect a different Google account, so the token is
// never keyed by (iss,sub). The callback (`/oidc/google/callback`, `purpose: 'connector'`) hands the tokens to the
// agent runtime over the custody bridge, which envelope-encrypts them under her SA per provider; the Home keeps nothing.
import { beginLogin } from '@agenticprimitives/connect-auth/google';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, json, type FnContext } from '../_lib/server-broker';
import { signBridgeCall } from '../_lib/bridge-hmac';

export type ConnectorName = 'calendar' | 'gmail' | 'drive';
export const CONNECTORS: Record<ConnectorName, { provider: 'google-calendar' | 'google-gmail' | 'google-drive'; read: string[]; write?: string[] }> = {
  calendar: { provider: 'google-calendar', read: ['https://www.googleapis.com/auth/calendar.readonly'], write: ['https://www.googleapis.com/auth/calendar.events'] },
  gmail: { provider: 'google-gmail', read: ['https://www.googleapis.com/auth/gmail.readonly'], write: ['https://www.googleapis.com/auth/gmail.compose'] },
  drive: { provider: 'google-drive', read: ['https://www.googleapis.com/auth/drive.readonly'] },
};
export const isConnectorName = (n: string): n is ConnectorName => n === 'calendar' || n === 'gmail' || n === 'drive';
// kept for the calendar's first callers
export const CALENDAR_SCOPE_READ = CONNECTORS.calendar.read[0]!;
export const CALENDAR_SCOPE_EVENTS = CONNECTORS.calendar.write![0]!;

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

export const onRequestPost = async (name: ConnectorName, { request, env }: FnContext): Promise<Response> => {
  const who = await personFromSession(env, request);
  if (!who) return json({ ok: false, error: 'unauthorized' }, 401);
  const c = CONNECTORS[name];
  const body = (await request.json().catch(() => null)) as { action?: string; write?: boolean; returnTo?: string } | null;
  if (body?.action === 'status') { const r = await connectorBridge(env, 'custody.connector.status', { person: who.person, provider: c.provider }); return json(r.body, r.status); }
  if (body?.action === 'disconnect') { const r = await connectorBridge(env, 'custody.connector.disconnect', { person: who.person, provider: c.provider }); return json(r.body, r.status); }
  if (body?.action !== 'start') return json({ ok: false, error: 'action: start | status | disconnect' }, 400);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) return json({ ok: false, error: 'Google is not configured on this Home' }, 503);
  const scope = ['openid', 'email', ...c.read, ...(body.write && c.write ? c.write : [])].join(' ');
  const { authUrl, codeVerifier, state, nonce } = beginLogin({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: env.GOOGLE_REDIRECT_URI, scope, prompt: 'consent', accessType: 'offline', includeGrantedScopes: true });
  const returnTo = typeof body.returnTo === 'string' && body.returnTo.startsWith('/') ? body.returnTo : '/apps';
  await env.AUTH_CODES.put(`oidc:${state}`, JSON.stringify({ codeVerifier, nonce, aud: env.DEMO_SSO_AUD ?? 'demo-sso', purpose: 'connector', connector: name, provider: c.provider, person: who.person, returnTo }), { expirationTtl: 600 });
  return json({ ok: true, url: authUrl });
};
