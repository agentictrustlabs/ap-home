// POST /connect/logout — end the recognition cookie (spec 445 §3.2). Script cannot clear an HttpOnly cookie, so without
// this a sign-out would leave it behind. Same origin only; the record goes first, so a lost response still ends it.
//
// `everywhere` (spec 445 §16) also deletes the renewal binding of every wire the person's apps hold, so that no app, whether or not it
// has a /sso-logout of its own, can silently renew its sign-in afterwards: its next renewal fails and it has to send the person to the
// Home. An id_token already issued stays valid to its own expiry: the Home cannot recall a token an app holds.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, json, ownIssuer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { clearRecognition, readRecognition } from '../_lib/recognition';
import { readRows, wireRef, type AppGrantRow } from '../oidc/app-grant-row';

const tail = (sub: string | undefined): string | null => sub?.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;

/** Who is leaving: the recognition cookie, or a real Home session (an id_token names no credential, and does not pass). */
async function personLeaving(request: Request, env: FnContext['env']): Promise<string | null> {
  const rec = await readRecognition(request, env.AUTH_CODES);
  if (rec) return tail(rec.sub);
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const { jwks } = await getServer(env);
  const v = await verifyAgentSession(auth.slice(7), { keys: await importJwks(jwks), expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  return v.ok && v.session.principal?.kind ? tail(v.session.sub) : null;
}

/** Every wire on the row, current or older: an app may be renewing on either. */
function refsOf(r: AppGrantRow): string[] {
  const wires = [r.delegation, r.askDelegation, r.selfVaultGrant, ...(r.superseded ?? []).map((s) => s.wire)];
  return wires.flatMap((w) => { try { return w ? [wireRef(w).toLowerCase()] : []; } catch { return []; } });
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const origin = request.headers.get('origin');
  if (!origin || origin !== resolveOrigin(request, env)) return json({ error: 'logout must be called from the home origin' }, 403);
  const body = (await request.json().catch(() => null)) as { everywhere?: boolean } | null;
  let renewalsEnded = 0;
  if (body?.everywhere === true) {
    // Best-effort and said: a store that cannot answer must not stop the person signing out of this Home.
    try {
      const person = await personLeaving(request, env);
      if (person) {
        for (const row of await readRows(env.AUTH_CODES, person)) {
          for (const ref of refsOf(row)) { await env.AUTH_CODES.delete(`oidc-deleg:${ref}`); renewalsEnded += 1; }
        }
      }
    } catch (e) {
      console.warn('[logout] renewals not ended:', e instanceof Error ? e.message : String(e));
    }
  }
  return clearRecognition(json({ ok: true, renewalsEnded }), { request, env });
};
