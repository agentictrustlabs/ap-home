// GET /jwks — the broker's public JWKS. Relying sites fetch this to verify the
// AgentSession (asymmetric; the private key never leaves the server).
import { getServer, jsonCors, preflight, type FnContext } from './_lib/server-broker';
import { isAllowedRelyingOriginAsync } from './_lib/oidc-registry';

const dynamicOriginOf = (request: Request, env: FnContext['env']): Promise<boolean> =>
  isAllowedRelyingOriginAsync(env, request.headers.get('Origin') ?? '');

export const onRequestOptions = async ({ request, env }: FnContext): Promise<Response> =>
  preflight(request, await dynamicOriginOf(request, env));

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const { jwks } = await getServer(env);
  // CORS so a relying-site SPA can verify the id_token — curated or member-registered alike.
  return jsonCors(jwks, request, 200, await dynamicOriginOf(request, env));
};
