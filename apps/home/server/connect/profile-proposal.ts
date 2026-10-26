// A PROFILE CHANGE PROPOSED BY AN APP, SAVED BY THE PERSON AT THEIR HOME.
//
//   POST /connect/profile-proposal   { firstName?, lastName?, about?, photo? }   bearer: the person (an app's id_token or a
//                                    Home session) → { ok, token, expiresAt }
//   GET  /connect/profile-proposal?token=…                               bearer: the SAME person's Home session
//                                    → { ok, client, fields, expiresAt }
//
// An app may READ the person's profile under its read grant (spec 341 §4.3b) and may never WRITE it — the
// interactions DO refuses an app's record.put by identity. So an app that lets someone edit their name or photo
// leaves the change HERE, and the person's own Home window (/profile-update) shows it beside what is saved and,
// on their "Save", writes it with their Home session. The proposal itself confers nothing: it is a suggestion
// held fifteen minutes, readable only by the person it names.
import { randomBytes } from 'node:crypto';
import { preflight, jsonCors, type FnContext } from '../_lib/server-broker';
import { personFromBearer } from '../_lib/person-bearer';

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> => preflight(request);

const TTL_SECONDS = 15 * 60;
const TOKEN_RE = /^[a-f0-9]{40}$/;
/** The photo the Home's profile takes: an inline JPEG/PNG/WebP data URL of a sane size (profile-store's rule). */
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PHOTO_CHARS = 200_000;
const KEY = (token: string) => `profile-proposal:${token}`;

export interface ProfileProposal {
  person: string;
  client: string | null;
  fields: { firstName?: string; lastName?: string; about?: string; photo?: string | null };
  expiresAt: number;
}

/** The fields an app may propose, cleaned: names trimmed and bounded, a photo only in the form the profile takes
 *  (null removes it). Anything else is dropped, never stored. */
export function proposalFields(body: unknown): ProfileProposal['fields'] | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ProfileProposal['fields'] = {};
  for (const k of ['firstName', 'lastName'] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'string') return { error: `${k} must be text` };
    out[k] = (b[k] as string).trim().slice(0, 80);
  }
  if (b.about !== undefined) {
    if (typeof b.about !== 'string') return { error: 'about must be text' };
    out.about = b.about.trim().slice(0, 300);
  }
  if (b.photo !== undefined) {
    if (b.photo === null) out.photo = null;
    else if (typeof b.photo === 'string' && PHOTO_RE.test(b.photo) && b.photo.length <= MAX_PHOTO_CHARS) out.photo = b.photo;
    else return { error: 'photo must be a JPEG, PNG or WebP image under 200 KB' };
  }
  if (!Object.keys(out).length) return { error: 'nothing to change' };
  return out;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const me = await personFromBearer(request, env);
  if (!me) return jsonCors({ error: 'sign in to change your profile' }, request, 401);
  const fields = proposalFields(await request.json().catch(() => null));
  if ('error' in fields) return jsonCors({ error: fields.error }, request, 400);
  const token = randomBytes(20).toString('hex');
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  const proposal: ProfileProposal = { person: me.person, client: me.client ?? null, fields, expiresAt };
  await env.AUTH_CODES.put(KEY(token), JSON.stringify(proposal), { expirationTtl: TTL_SECONDS });
  return jsonCors({ ok: true, token, expiresAt }, request);
};

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const me = await personFromBearer(request, env);
  // Only the person's own Home reads a proposal back — never an app (it would read back only what it wrote, but the
  // page that saves it is the Home's, and that is the only reader there is).
  if (!me || me.via !== 'session') return jsonCors({ error: 'open this at your Home' }, request, 401);
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!TOKEN_RE.test(token)) return jsonCors({ error: 'invalid token' }, request, 400);
  const raw = await env.AUTH_CODES.get(KEY(token));
  const p = raw ? (JSON.parse(raw) as ProfileProposal) : null;
  if (!p || p.expiresAt < Date.now()) return jsonCors({ error: 'this change has expired — make it again in the app' }, request, 404);
  if (p.person !== me.person) return jsonCors({ error: 'this change is for someone else' }, request, 403);
  return jsonCors({ ok: true, client: p.client, fields: p.fields, expiresAt: p.expiresAt }, request);
};
