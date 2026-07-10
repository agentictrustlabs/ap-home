// POST /connect/email/verify — verify the emailed code, then one of three outcomes:
//   • Bearer session present  → LINK: record the email facet for that signed-in agent (add email as a
//     login method; same security model as the Google link path — a custody/login session authorizes it).
//   • email facet exists      → ISSUE a login-grade session (asserted; email is never custody-grade).
//   • no facet                → BOOTSTRAP (a new person home needs to be created; client onboards).
// The OTP record is keyed by SHA-256(email); the code is checked with bounded attempts (anti-brute-force).
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { mintAgentSession, importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { readEmailFacet, recordEmailFacet, emailHash } from '../../src/lib/kv-indexer';
import type { CredentialPrincipal, CanonicalAgentId } from '@agenticprimitives/types';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_ATTEMPTS = 5;

/** Resolve a signed-in session principal (person SA) from the Bearer, or null (anonymous verify). */
async function sessionAgent(request: Request, env: FnContext['env']): Promise<CanonicalAgentId | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  return v.ok ? (v.session.sub as CanonicalAgentId) : null;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { email?: string; otp?: string } | null;
  const email = (body?.email ?? '').trim().toLowerCase();
  const otp = (body?.otp ?? '').trim();
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(otp)) return json({ error: 'email + 6-digit code required' }, 400);

  const hash = await emailHash(email);
  const key = `emailotp:${hash}`;
  const raw = await env.AUTH_CODES.get(key);
  if (!raw) return json({ error: 'code expired — request a new one' }, 400);
  const rec = JSON.parse(raw) as { code: string; aud: string; attempts: number };

  if (rec.code !== otp) {
    const attempts = (rec.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await env.AUTH_CODES.delete(key);
      return json({ error: 'too many attempts — request a new code' }, 429);
    }
    await env.AUTH_CODES.put(key, JSON.stringify({ ...rec, attempts }), { expirationTtl: 600 });
    return json({ error: 'incorrect code' }, 400);
  }
  await env.AUTH_CODES.delete(key); // single-use — consumed on the first correct code

  // LINK: a signed-in user is adding email as a login method → record the facet for THEIR agent.
  const signedIn = await sessionAgent(request, env);
  if (signedIn) {
    await recordEmailFacet(env.AUTH_CODES, email, signedIn);
    return json({ status: 'linked', via: 'email' });
  }

  // ISSUE or BOOTSTRAP.
  const agent = await readEmailFacet(env.AUTH_CODES, email);
  if (!agent) return json({ status: 'bootstrap', via: 'email', email });

  const iss = resolveOrigin(request, env);
  const { signer } = await getServer(env);
  const principal: CredentialPrincipal = { kind: 'email', id: hash, assurance: 'asserted', role: 'login-grade' };
  const token = await mintAgentSession(
    { sub: agent, principal, assurance: 'asserted', aud: rec.aud, iss, ttlSeconds: 3600 },
    signer,
  );
  return json({ status: 'issued', token, via: 'email' });
};
