// GET /connect/nonce → a single-use SIWE nonce (KV, 5-min TTL). The browser
// embeds it in the SIWE message; /connect/siwe consumes it once (replay guard).
// CORS-enabled (spec 247) so a relying app (demo-jp) can drive a SIWE handoff
// cross-origin — only for registered relying-app origins.
import { type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'Origin' }
    : {};
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  await env.AUTH_CODES.put(`nonce:${nonce}`, '1', { expirationTtl: 300 });
  return new Response(JSON.stringify({ nonce }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...cors(request) },
  });
};
