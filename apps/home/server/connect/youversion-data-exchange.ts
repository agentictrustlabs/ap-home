// Connect — YouVersion Data Exchange consent kickoff (spec 265 W5). Person-session-authorized.
//
//   GET /connect/youversion/data-exchange  → { ok, approveUrl }
//
// YouVersion does NOT grant highlights via an OIDC scope at sign-in — it gates highlights behind a separate
// "Data Exchange" consent flow. Using the person's KMS-custodied access_token (server-side, in demo-a2a),
// we mint a short-lived data-exchange token, then hand the browser the YouVersion approval URL to navigate
// to. The user approves "highlights" there; YouVersion redirects back to the app's Portal-configured
// data-exchange callback; afterwards the access_token is authorized for GET /v1/highlights. The federated
// access_token never reaches the browser — only the dx-token (which is DESIGNED to ride the browser URL).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, json, type FnContext } from '../_lib/server-broker';
import { signBridgeCall } from '../_lib/bridge-hmac';

const YV_BASE = 'https://api.youversion.com';

async function personFromSession(env: FnContext['env'], request: Request): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const iss = resolveOrigin(request, env);
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: homeAud, expectedIss: iss });
  if (!v.ok) return null;
  return v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
}

/** GET — mint a YouVersion data-exchange token for the signed-in person and return the approval URL the
 *  browser should navigate to. */
export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFromSession(env, request);
  if (!person) return json({ error: 'unauthorized' }, 401);
  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) return json({ error: 'custody_bridge_not_configured' }, 503);

  const audience = 'custody.youversion.data-exchange';
  const envelope = await signBridgeCall({ secret: env.A2A_CUSTODY_BRIDGE_SECRET, audience, payload: { sender: person } });
  const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}/custody/youversion/data-exchange-token`, {
    method: 'POST',
    headers: envelope.headers,
    body: envelope.body,
  });
  const j = (await res.json().catch(() => null)) as { ok?: boolean; token?: string; appKey?: string; error?: string; detail?: unknown } | null;
  if (!res.ok || !j?.ok || !j.token) {
    return json({ error: j?.error ?? `data_exchange HTTP ${res.status}`, detail: j?.detail }, res.status);
  }

  // The browser navigates here; the user approves "highlights"; YouVersion redirects to the app's
  // Portal-configured data-exchange callback. The app key identifies our app on the approval page.
  const appKey = j.appKey ?? env.YOUVERSION_CLIENT_ID ?? '';
  const approveUrl = `${YV_BASE}/data-exchange?token=${encodeURIComponent(j.token)}&x-yvp-app-key=${encodeURIComponent(appKey)}`;
  return json({ ok: true, approveUrl });
};
