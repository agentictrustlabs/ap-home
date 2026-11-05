// POST /connect/logout — end the recognition cookie (spec 445 §3.2). Script cannot clear an HttpOnly cookie, so without
// this a sign-out would leave it behind. Same origin only; the record goes first, so a lost response still ends it.
import { json, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { clearRecognition } from '../_lib/recognition';

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const origin = request.headers.get('origin');
  if (!origin || origin !== resolveOrigin(request, env)) return json({ error: 'logout must be called from the home origin' }, 403);
  return clearRecognition(json({ ok: true }), { request, env });
};
