// GET /connect/link/lookup?code=ABC123 — the ORIGINAL device fetches a pending
// link request to show + approve (spec 233 P2). Returns public passkey data only.
import { json, type FnContext } from '../_lib/server-broker';

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return json({ error: 'code required' }, 400);
  const raw = await env.AUTH_CODES.get(`linkreq:${code.trim().toUpperCase()}`);
  if (!raw) return json({ error: 'invalid or expired code' }, 404);
  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ error: 'corrupt link request' }, 500);
  }
};
