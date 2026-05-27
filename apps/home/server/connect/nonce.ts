// GET /connect/nonce → a single-use SIWE nonce (KV, 5-min TTL). The browser
// embeds it in the SIWE message; /connect/siwe consumes it once (replay guard).
import { json, type FnContext } from '../_lib/server-broker';

export const onRequestGet = async ({ env }: FnContext): Promise<Response> => {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  await env.AUTH_CODES.put(`nonce:${nonce}`, '1', { expirationTtl: 300 });
  return json({ nonce });
};
