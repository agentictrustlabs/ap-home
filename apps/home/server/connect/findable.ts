// /connect/findable — whether people who have your email address can find you by it (the email owners index,
// src/lib/kv-indexer.ts). On unless you turn it off. The bearer is a Home session or a registered app's id_token.
//
//   GET                       → { ok, email: boolean }
//   POST { email: boolean }   → { ok, email: boolean }
import { isFindableByEmail, setFindableByEmail } from '../../src/lib/kv-indexer';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { personFromBearer } from '../_lib/person-bearer';
import type { FnContext } from '../_lib/server-broker';

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

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const me = await personFromBearer(request, env);
  if (!me) return jsonCors({ error: 'sign in first' }, request, 401);
  return jsonCors({ ok: true, email: await isFindableByEmail(env.AUTH_CODES, me.person) }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const me = await personFromBearer(request, env);
  if (!me) return jsonCors({ error: 'sign in first' }, request, 401);
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  if (typeof body?.email !== 'boolean') return jsonCors({ error: 'email: true or false' }, request, 400);
  await setFindableByEmail(env.AUTH_CODES, me.person, body.email);
  return jsonCors({ ok: true, email: body.email }, request);
};
