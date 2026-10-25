// /connect/friend-invite — a person invites a FRIEND by email (spec 401 C1, the person's word).
//
//   POST /connect/friend-invite/email   { email, note?, fromName? }        bearer: the inviter
//     → { ok, token, delivery:'sent'|'logged', expiresAt } — the same address invited again (still open) is sent the
//       same invitation again rather than a second one.
//   POST /connect/friend-invite/email   { token, claim:true }              bearer: the INVITEE, signed in
//     → { ok, claimed, from } — the invitation is marked accepted by them (the inviter's list shows who).
//   POST /connect/friend-invite/email   { token, cancel:true | resend:true } bearer: the inviter
//   GET  /connect/friend-invite/email                                       bearer: the inviter
//     → { ok, sent:[{ token, email, createdAt, expiresAt, acceptedBy?, acceptedAt? }] } — their invitations
//   GET  /connect/friend-invite/lookup?token=…   (the landing page; the token IS the secret)
//     → { ok, from, fromName, note, expiresAt, accepted }
//
// The bearer is a Home session or the id_token of a registered app the person signed in to (the reader holds one) —
// so a person invites from inside an app with no Home window. Mail sent under a Home session goes out AS the person
// (their copy threads into their inbox); from an app it goes out as the Home's own mail naming them.
//
// The invitation carries NO authority (unlike an org invite): being friends is two contact grants each person signs
// at their own Home, and nothing here stands in for either. The stash is a pointer — who invited, the SHA-256 of
// the invited address, a note, and once accepted, who accepted — so the landing page can name the inviter and the
// inviter's apps can see who joined from their invitation and complete their side. The address itself is kept only
// in the inviter's own list (it is their entry, typed by them), so they can see and resend what they sent.
import { createHash } from 'node:crypto';
import { resolveOrigin, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { personFromBearer } from '../_lib/person-bearer';
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
/** An accepted invitation is kept a while longer, so the inviter's apps see who joined even after a few weeks away. */
const ACCEPTED_TTL_SECONDS = 60 * 24 * 3600;
const SENT_CAP = 100;
const KEY = (token: string) => `friend-invite:${token}`;
const SENT_KEY = (person: string) => `friend-invites-sent:${person.toLowerCase()}`;

export interface FriendInviteStash {
  from: string;
  fromName: string | null;
  emailHash: string;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  /** Where the invitation was made from (a registered app's origin) — its link lands there. */
  origin?: string | null;
  acceptedBy?: string;
  acceptedAt?: number;
}

export interface SentInvite {
  token: string;
  email: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy?: string;
  acceptedAt?: number;
}

type Kv = FnContext['env']['AUTH_CODES'];

async function readSent(kv: Kv, person: string): Promise<SentInvite[]> {
  try {
    const list = JSON.parse((await kv.get(SENT_KEY(person))) ?? '[]') as SentInvite[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Open invitations and accepted ones still worth showing; expired, unaccepted ones fall away. */
export function keptSent(list: SentInvite[], now: number): SentInvite[] {
  return list
    .filter((s) => (s.acceptedAt ? s.acceptedAt + ACCEPTED_TTL_SECONDS * 1000 > now : s.expiresAt > now))
    .slice(-SENT_CAP);
}

async function writeSent(kv: Kv, person: string, list: SentInvite[]): Promise<void> {
  await kv.put(SENT_KEY(person), JSON.stringify(keptSent(list, Date.now())));
}

const hashOf = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** The app a link should land in: the request's own origin when it is a registered app's, else the Home. */
function landingOrigin(request: Request, env: FnContext['env'], stashed?: string | null): string {
  const origin = stashed ?? request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin) ? origin : resolveOrigin(request, env);
}

function brandFor(client: string | undefined): string {
  const app = client ? whitelabel.relyingApps.find((a) => a.client_id === client) : undefined;
  return app?.name ?? whitelabel.brand.name;
}

async function deliver(
  env: FnContext['env'],
  request: Request,
  me: NonNullable<Awaited<ReturnType<typeof personFromBearer>>>,
  email: string,
  token: string,
  stash: FriendInviteStash,
): Promise<{ ok: boolean; error?: string }> {
  const origin = landingOrigin(request, env, stash.origin);
  const joinUrl = origin === resolveOrigin(request, env) ? `${origin}/invite/friend/${token}` : `${origin}/invite/${token}`;
  const mail = friendInviteEmail(email, stash.fromName ?? 'A friend', joinUrl, brandFor(me.client), stash.note);
  return sendEmail(env, mail, me.via === 'session' ? { session: me.token, as: me.person } : undefined);
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as {
    email?: string; note?: string; fromName?: string; token?: string; claim?: boolean; cancel?: boolean; resend?: boolean;
  } | null;
  const me = await personFromBearer(request, env);
  if (!me) return jsonCors({ error: 'sign in to invite a friend' }, request, 401);
  const kv = env.AUTH_CODES;
  const now = Date.now();

  if (body?.claim || body?.cancel || body?.resend) {
    const token = (body.token ?? '').trim();
    if (!TOKEN_RE.test(token)) return jsonCors({ error: 'invalid token' }, request, 400);
    const raw = await kv.get(KEY(token));
    const stash = raw ? (JSON.parse(raw) as FriendInviteStash) : null;

    // THE CLAIM — the invitee, signed in, took the invitation: it is theirs now, and the inviter's list says so.
    if (body.claim) {
      if (!stash || (!stash.acceptedBy && stash.expiresAt < now)) return jsonCors({ ok: true, claimed: false, note: 'expired or cancelled' }, request);
      if (stash.from === me.person) return jsonCors({ error: 'this is your own invitation' }, request, 400);
      if (stash.acceptedBy && stash.acceptedBy !== me.person) return jsonCors({ ok: true, claimed: false, note: 'already used' }, request);
      if (!stash.acceptedBy) {
        const accepted: FriendInviteStash = { ...stash, acceptedBy: me.person, acceptedAt: now };
        await kv.put(KEY(token), JSON.stringify(accepted), { expirationTtl: ACCEPTED_TTL_SECONDS });
        const sent = await readSent(kv, stash.from);
        await writeSent(kv, stash.from, sent.map((s) => (s.token === token ? { ...s, acceptedBy: me.person, acceptedAt: now } : s)));
      }
      return jsonCors({ ok: true, claimed: true, from: stash.from }, request);
    }

    // CANCEL and RESEND are the inviter's own.
    const sent = await readSent(kv, me.person);
    const mine = sent.find((s) => s.token === token);
    if (!mine) return jsonCors({ error: 'not an invitation of yours' }, request, 404);
    if (body.cancel) {
      if (stash && !stash.acceptedBy) await kv.delete(KEY(token));
      await writeSent(kv, me.person, sent.filter((s) => s.token !== token));
      return jsonCors({ ok: true, cancelled: true }, request);
    }
    if (!stash || stash.acceptedBy) return jsonCors({ error: stash ? 'already accepted' : 'this invitation has expired' }, request, 409);
    const sentNow = await deliver(env, request, me, mine.email, token, stash);
    if (!sentNow.ok) return jsonCors({ error: `could not send the invitation: ${sentNow.error}` }, request, 502);
    return jsonCors({ ok: true, resent: true }, request);
  }

  const email = (body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return jsonCors({ error: 'email required' }, request, 400);
  const note = (body?.note ?? '').trim().slice(0, 500) || null;
  // The inviter's name as they gave it (their own claim about themselves); the Worker's rail signs mail sent as
  // them with the name the chain resolves for the sender, so a made-up name cannot pass as someone else's.
  const fromName = (body?.fromName ?? '').trim().slice(0, 80) || null;
  const emailHash = hashOf(email);

  const sent = await readSent(kv, me.person);
  const open = keptSent(sent, now).find((s) => !s.acceptedBy && hashOf(s.email) === emailHash);
  if (open) {
    const raw = await kv.get(KEY(open.token));
    if (raw) {
      const again = await deliver(env, request, me, email, open.token, JSON.parse(raw) as FriendInviteStash);
      if (!again.ok) return jsonCors({ error: `could not send the invitation: ${again.error}` }, request, 502);
      return jsonCors({ ok: true, token: open.token, again: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', expiresAt: new Date(open.expiresAt).toISOString() }, request);
    }
  }

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const origin = request.headers.get('Origin');
  const stash: FriendInviteStash = {
    from: me.person,
    fromName,
    emailHash,
    note,
    createdAt: now,
    expiresAt: now + INVITE_TTL_SECONDS * 1000,
    origin: origin && isAllowedClientOrigin(origin) ? origin : null,
  };
  await kv.put(KEY(token), JSON.stringify(stash), { expirationTtl: INVITE_TTL_SECONDS });
  const delivered = await deliver(env, request, me, email, token, stash);
  if (!delivered.ok) {
    await kv.delete(KEY(token));
    return jsonCors({ error: `could not send the invitation: ${delivered.error}` }, request, 502);
  }
  await writeSent(kv, me.person, [...sent, { token, email, createdAt: now, expiresAt: stash.expiresAt }]);
  return jsonCors({ ok: true, token, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', expiresAt: new Date(stash.expiresAt).toISOString() }, request);
};

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const token = (new URL(request.url).searchParams.get('token') ?? '').trim();
  // No token: the signed-in inviter's own list.
  if (!token) {
    const me = await personFromBearer(request, env);
    if (!me) return jsonCors({ error: 'sign in to see your invitations' }, request, 401);
    return jsonCors({ ok: true, sent: keptSent(await readSent(env.AUTH_CODES, me.person), Date.now()) }, request);
  }
  if (!TOKEN_RE.test(token)) return jsonCors({ error: 'invalid token' }, request, 400);
  const raw = await env.AUTH_CODES.get(KEY(token));
  if (!raw) return jsonCors({ error: 'this invitation has expired or was cancelled' }, request, 404);
  const stash = JSON.parse(raw) as FriendInviteStash;
  if (!stash.acceptedBy && stash.expiresAt < Date.now()) return jsonCors({ error: 'this invitation has expired' }, request, 404);
  return jsonCors({
    ok: true, from: stash.from, fromName: stash.fromName, note: stash.note,
    expiresAt: new Date(stash.expiresAt).toISOString(), accepted: !!stash.acceptedBy,
  }, request);
};
