// A relying app's display projection of the person's own Home profile. Forward its EXACT bearer
// to the runtime, which requires the app's read grant and checks revocation and record scope.
// Never substitute a Home session or the broad interactions grant. No contact details leave here.
import { type FnContext, corsHeaders } from '../_lib/server-broker';
import { personFromBearer } from '../_lib/person-bearer';

function headers(request: Request) {
  return { ...corsHeaders(request), 'access-control-allow-headers': 'authorization, content-type',
    'cache-control': 'private, no-store', 'content-type': 'application/json' };
}
export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: headers(request) });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: headers(request) });
  const me = await personFromBearer(request, env);
  if (!me) return json({ error: 'Sign in to read your Home profile.' }, 401);
  // No caller-selected subject, even when a query parameter names someone else.
  const base = (env as { A2A_CUSTODY_URL?: string }).A2A_CUSTODY_URL?.replace(/\/$/, '');
  if (!base) return json({ error: 'Home profile service is not configured.' }, 503);
  try {
    const response = await fetch(`${base}/interactions/${me.person}/record.get`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: me.token, recordType: 'impact-profile' }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json() as { ok?: boolean; code?: string; error?: string; record?: { contact?: Record<string, unknown> } | null };
    if (!response.ok || value.ok !== true) return json({
      error: value.error ?? 'Your Home profile could not be read.', code: value.code ?? 'profile_unreadable',
    }, response.ok ? 502 : response.status);
    const contact = value.record?.contact ?? {};
    const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 80) : '';
    const photo = contact.photo;
    const validPhoto = typeof photo === 'string' && photo.length <= 200_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo);
    if (photo != null && photo !== '' && !validPhoto)
      return json({ error: 'The photo saved at Home cannot be displayed.', code: 'profile_photo_invalid' }, 422);
    return json({ ok: true, person: me.person, firstName: text(contact.firstName), lastName: text(contact.lastName), photo: validPhoto ? photo : null });
  } catch {
    return json({ error: 'Your Home profile is temporarily unavailable.', code: 'profile_unavailable' }, 502);
  }
};
