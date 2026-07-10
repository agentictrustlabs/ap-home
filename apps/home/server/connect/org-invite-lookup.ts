// GET /connect/org-invite/lookup?token=… → { org, orgName } for a valid, unexpired invite (the redeem
// page reads it). The token IS the secret; no session required to look it up (you hold the link).
import type { FnContext } from '../_lib/server-broker';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const token = (new URL(request.url).searchParams.get('token') ?? '').trim();
  if (!/^[a-f0-9]{40,80}$/.test(token)) return json({ error: 'invalid token' }, 400);
  const raw = await env.AUTH_CODES.get(`orginvite:${token}`);
  if (!raw) return json({ error: 'this invitation has expired or was already used' }, 404);
  const inv = JSON.parse(raw) as { org: string; orgName: string };
  return json({ ok: true, org: inv.org, orgName: inv.orgName });
};
