// Connect YouVersion data surface (spec 265 W4). Person-session-authorized (Bearer AgentSession verified
// against the broker JWKS; the person SA is the token `sub`).
//
//   GET  /connect/youversion?type=highlights         → the PERSON's own YouVersion data (self-read).
//   POST /connect/youversion  { clientId, scopes }   → set which YouVersion data types `clientId` may read
//                                                       (the VaultGrant data-scope), written under the
//                                                       person's authority via the demo-a2a bridge.
//
// Neither path ever exposes the federated token — demo-a2a holds it; we only ever see the DATA (self-read)
// or write a grant record. YouVersion's Platform API exposes exactly one user-data resource: highlights,
// read per Bible chapter (GET /v1/highlights?bible_id=&passage_id=<chapter>). There is no notes/bookmarks/
// saved-verses API, so highlights is the only data type.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, json, type FnContext } from '../_lib/server-broker';
import { getClient, getClientDelegate } from '../../src/lib/oidc-clients';
import { signBridgeCall } from '../_lib/bridge-hmac';

const DATA_TYPES = ['highlights'];
const DEFAULT_YV_VERSION = '111'; // NIV
const DEFAULT_YV_PASSAGE = 'JHN.3';

/** Verify the caller's AgentSession → the person SA (lowercased 0x…40), or null. */
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

async function bridge(env: FnContext['env'], audience: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  if (!env.A2A_CUSTODY_URL || !env.A2A_CUSTODY_BRIDGE_SECRET) return { status: 503, body: { error: 'custody_bridge_not_configured' } };
  const path = audience === 'custody.youversion.fetch' ? '/custody/youversion/fetch' : '/custody/youversion/set-grant';
  const envelope = await signBridgeCall({ secret: env.A2A_CUSTODY_BRIDGE_SECRET, audience, payload });
  const res = await fetch(`${env.A2A_CUSTODY_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: envelope.headers, body: envelope.body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** GET — the person reads their OWN YouVersion data (no app/delegation; it's their own home). */
export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFromSession(env, request);
  if (!person) return json({ error: 'unauthorized' }, 401);
  const qp = new URL(request.url).searchParams;
  const type = qp.get('type') ?? 'highlights';
  if (!DATA_TYPES.includes(type)) return json({ error: 'unknown_type' }, 400);
  // Highlights are per Bible chapter — bible_id + passage_id (chapter USFM) are required. The API is
  // mid-migration version_id→bible_id, so send both names. Caller may pick the version/chapter.
  const version = (qp.get('version') ?? DEFAULT_YV_VERSION).replace(/[^0-9]/g, '') || DEFAULT_YV_VERSION;
  const passage = (qp.get('passage') ?? DEFAULT_YV_PASSAGE).trim() || DEFAULT_YV_PASSAGE;
  const path = `/v1/${type}?bible_id=${version}&version_id=${version}&passage_id=${encodeURIComponent(passage)}`;
  const r = await bridge(env, 'custody.youversion.fetch', { sender: person, path });
  return json(r.body, r.status);
};

/** POST — set the VaultGrant data scopes a connected app may read. */
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFromSession(env, request);
  if (!person) return json({ error: 'unauthorized' }, 401);
  const body = (await request.json().catch(() => null)) as { clientId?: string; scopes?: string[] } | null;
  if (!body?.clientId || !Array.isArray(body?.scopes)) return json({ error: 'clientId + scopes required' }, 400);
  const client = getClient(body.clientId);
  if (!client) return json({ error: 'unknown_client' }, 400);
  const app = getClientDelegate(client);
  const scopes = body.scopes.filter((s) => DATA_TYPES.includes(s));
  const r = await bridge(env, 'custody.youversion.set-grant', { person, app, scopes });
  return json(r.status === 200 ? { ok: true, scopes } : r.body, r.status);
};
