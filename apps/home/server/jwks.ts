// GET /jwks — the broker's public JWKS. Relying sites fetch this to verify the
// AgentSession (asymmetric; the private key never leaves the server).
import { getServer, jsonCors, preflight, type FnContext } from './_lib/server-broker';

export const onRequestOptions = ({ request }: FnContext): Response => preflight(request);

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const { jwks } = await getServer(env);
  return jsonCors(jwks, request); // CORS so a relying-site SPA can verify the id_token
};
