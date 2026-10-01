// POST /connect/phone/unlink { value }  (Bearer session) — spec 422 §3.3.
//
// A channel OPENS the home and signs nothing, so unlinking it needs the session (login-grade is enough) and
// nothing on chain. The facet is TOMBSTONED, never deleted (SEC-009: the index stays append-only and auditable);
// the Home records the unlink in the person's vault (`security.channels`) after this returns.
// The agent is the SESSION's subject — a client never names which agent to unlink from.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import type { CanonicalAgentId } from '@agenticprimitives/types';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { unlinkPhoneFacet } from '../../src/lib/kv-indexer';
import { normalizeE164 } from '../_lib/sms-sender';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  const agent = v.session.sub as CanonicalAgentId;

  const body = (await request.json().catch(() => null)) as { value?: string } | null;
  const value = normalizeE164(body?.value ?? '');
  if (!value) return json({ error: 'phone required' }, 400);
  const was = await unlinkPhoneFacet(env.AUTH_CODES, value, agent);
  return json({ ok: true, unlinked: was });
};
