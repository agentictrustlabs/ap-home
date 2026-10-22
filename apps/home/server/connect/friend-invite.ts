// /connect/friend-invite — a person invites a FRIEND who has no Home yet, by email (spec 401 C1, the person's word).
//
//   POST /connect/friend-invite/email   { email, note? }     bearer: the inviter's Home session
//     → { ok, delivery:'sent'|'logged', expiresAt }
//   GET  /connect/friend-invite/lookup?token=…                 (the landing page; the token IS the secret)
//     → { ok, from, fromName, note, expiresAt }
//   POST /connect/friend-invite/email   { token, claim:true } bearer: the INVITEE's Home session, once they added the
//     inviter back → { ok } — the stash is consumed.
//
// The invitation carries NO authority (unlike an org invite): being friends is two contact grants each person signs
// at their own Home, and nothing in this stash can stand in for either. The stash is a pointer — who invited, the
// SHA-256 of the invited address (never the address), a note — so the landing page can name the inviter and the
// invitee can add them back in one tap (`person.contact.invite`, role friend, through the Ask); the inviter then
// sees "Add back" in their messages, as for any contact. Losing this KV loses pending invitations, nothing else.
// The mail goes out AS THE PERSON through the Worker's rail (`/email/send` with their session), so their own copy
// lands in their inbox thread with that address.
import { createHash } from 'node:crypto';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { sendEmail, friendInviteEmail, emailSendingEnabled } from '../_lib/email-sender';
import { whitelabel } from '../../src/whitelabel/config';

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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_RE = /^[a-f0-9]{40,80}$/;
/** An invitation is an offer, not a standing state — two weeks unclaimed, it expires. */
const INVITE_TTL_SECONDS = 14 * 24 * 3600;
const KEY = (token: string) => `friend-invite:${token}`;

export interface FriendInviteStash {
  from: string;
  fromName: string | null;
  emailHash: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
}

async function sessionOf(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(bearer, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token: bearer } : null;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { email?: string; note?: string; fromName?: string; token?: string; claim?: boolean } | null;
  const me = await sessionOf(request, env);
  if (!me) return jsonCors({ error: 'a Home session is required' }, request, 401);

  // THE CLAIM LEG — the invitee, signed in, added the inviter back: the stash is spent.
  if (body?.claim) {
    const token = (body.token ?? '').trim();
    if (!TOKEN_RE.test(token)) return jsonCors({ error: 'invalid token' }, request, 400);
    const raw = await env.AUTH_CODES.get(KEY(token));
    if (!raw) return jsonCors({ ok: true, claimed: false, note: 'already used or expired' }, request);
    await env.AUTH_CODES.delete(KEY(token));
    return jsonCors({ ok: true, claimed: true }, request);
  }

  const email = (body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return jsonCors({ error: 'email required' }, request, 400);
  const note = (body?.note ?? '').trim().slice(0, 500) || null;
  // The inviter's name as their session knows it (their own claim about themselves); the Worker's rail signs the
  // mail with the name the chain resolves for the sender, so a made-up name cannot pass as someone else's.
  const fromName = (body?.fromName ?? '').trim().slice(0, 80) || null;

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const now = Date.now();
  const stash: FriendInviteStash = {
    from: me.person,
    fromName,
    emailHash: createHash('sha256').update(email).digest('hex'),
    note,
    createdAt: now,
    expiresAt: now + INVITE_TTL_SECONDS * 1000,
  };
  await env.AUTH_CODES.put(KEY(token), JSON.stringify(stash), { expirationTtl: INVITE_TTL_SECONDS });

  const joinUrl = `${resolveOrigin(request, env)}/invite/friend/${token}`;
  const sent = await sendEmail(env, friendInviteEmail(email, fromName ?? 'A friend', joinUrl, whitelabel.brand.name, note), { session: me.token, as: me.person });
  if (!sent.ok) {
    await env.AUTH_CODES.delete(KEY(token));
    return jsonCors({ error: `could not send the invitation: ${sent.error}` }, request, 502);
  }
  return jsonCors({ ok: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', expiresAt: new Date(stash.expiresAt).toISOString() }, request);
};

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const token = (new URL(request.url).searchParams.get('token') ?? '').trim();
  if (!TOKEN_RE.test(token)) return jsonCors({ error: 'invalid token' }, request, 400);
  const raw = await env.AUTH_CODES.get(KEY(token));
  if (!raw) return jsonCors({ error: 'this invitation has expired or was already used' }, request, 404);
  const stash = JSON.parse(raw) as FriendInviteStash;
  if (stash.expiresAt < Date.now()) return jsonCors({ error: 'this invitation has expired' }, request, 404);
  return jsonCors({ ok: true, from: stash.from, fromName: stash.fromName, note: stash.note, expiresAt: new Date(stash.expiresAt).toISOString() }, request);
};
