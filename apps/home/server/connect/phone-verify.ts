// POST /connect/phone/verify — verify the SMS code, then one of three outcomes (mirrors email-verify):
//   • Bearer session present  → LINK: record the phone facet for that signed-in agent (add phone as a
//     login/recovery method; same model as the email/Google link path).
//   • phone facet exists       → ISSUE a session for the resolved home.
//   • no home of its own        → BOOTSTRAP a per-subject KMS-custodied home (iss='phone', sub=SHA-256(E.164)),
//     mirroring email-bootstrap / Google × KMS (spec 235). The phone FACET stays login-grade/asserted
//     (enroll rejects kind:'phone'); C_sub (KMS), not the phone, is the on-chain custodian.
//
// Verification is delegated to Twilio Verify when configured; otherwise a self-stored dev OTP (deploy-safe).
// SMS is a CONTACT-CONTROL signal (SIM-swap-prone) — the intended durable path is: bootstrap here, then the
// client prompts a passkey (see PhoneAuthCard). This route does not itself gate high-trust authority.
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { mintAgentSession, importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { checkPhoneVerification, normalizeE164 } from '../_lib/sms-sender';
import { readPhoneFacet, recordPhoneFacet, phoneHash, readRotation } from '../../src/lib/kv-indexer';
import { resolveKmsAgent } from '../_lib/kms-resolve';
import { isSocialCustodyAud } from '../../src/lib/oidc-clients';
import { oidcFacetId } from '@agenticprimitives/connect-auth/google';
import type { CredentialPrincipal, CanonicalAgentId } from '@agenticprimitives/types';

// The (iss, sub) namespace for phone-subject KMS custody — WE are the issuer authority (no OIDC provider):
// `iss = 'phone'`, `sub = SHA-256(E.164)`. demo-a2a derives C_sub from exactly this pair (spec 235, provider-
// neutral OIDC-subject custody) — the SAME mechanism as email, so the custody session is minted OIDC-shaped.
const PHONE_ISS = 'phone';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

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
  const body = (await request.json().catch(() => null)) as { phone?: string; otp?: string } | null;
  const phone = normalizeE164(body?.phone ?? '');
  const otp = (body?.otp ?? '').trim();
  if (!phone || !/^\d{4,10}$/.test(otp)) return json({ error: 'phone (E.164) + code required' }, 400);

  const hash = await phoneHash(phone);
  const key = `phoneverify:${hash}`;
  const raw = await env.AUTH_CODES.get(key);
  if (!raw) return json({ error: 'code expired — request a new one' }, 400);
  const rec = JSON.parse(raw) as { aud: string; provider: 'twilio' | 'dev'; code?: string; attempts?: number };

  // Verify the code — Twilio Verify when configured, else the self-stored dev OTP (bounded attempts).
  let verified = false;
  if (rec.provider === 'twilio') {
    verified = (await checkPhoneVerification(env, phone, otp)).approved; // Twilio enforces its own attempt limits
    if (!verified) return json({ error: 'incorrect or expired code' }, 400);
  } else {
    if (rec.code !== otp) {
      const attempts = (rec.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await env.AUTH_CODES.delete(key);
        return json({ error: 'too many attempts — request a new code' }, 429);
      }
      await env.AUTH_CODES.put(key, JSON.stringify({ ...rec, attempts }), { expirationTtl: 600 });
      return json({ error: 'incorrect code' }, 400);
    }
    verified = true;
  }
  await env.AUTH_CODES.delete(key); // single-use — consumed on the first correct code

  // LINK: a signed-in user is adding phone as a login/recovery method → record the facet for THEIR agent.
  const signedIn = await sessionAgent(request, env);
  if (signedIn) {
    await recordPhoneFacet(env.AUTH_CODES, phone, signedIn);
    return json({ status: 'linked', via: 'phone' });
  }

  // ── ANONYMOUS: ISSUE (known home) or BOOTSTRAP (create a KMS-custodied home). Mirrors email-verify. ──
  const iss = resolveOrigin(request, env);
  const { signer } = await getServer(env);
  const custodyAud = env.DEMO_SSO_AUD ?? 'demo-sso';

  const facet = await readPhoneFacet(env.AUTH_CODES, phone); // prior phone-home OR a linked device home
  const custodyEligible = isSocialCustodyAud(rec.aud, custodyAud);
  const rotation = await readRotation(env.AUTH_CODES, PHONE_ISS, hash);
  let kms = custodyEligible ? await resolveKmsAgent(env, PHONE_ISS, hash, rotation) : ({ ok: false, reason: 'aud not custody-eligible' } as const);
  // Mirror email-verify: a transient resolve failure must NOT silently demote a returning
  // custody-grade user — the demoted session 403s later at demo-a2a's custody sign gate mid-connect.
  if (custodyEligible && !kms.ok) {
    kms = await resolveKmsAgent(env, PHONE_ISS, hash, rotation); // one retry
    if (!kms.ok && facet) {
      console.error('[phone-verify] KMS resolve failed for a custody-eligible subject with a facet — refusing to demote', { reason: kms.reason, facet });
      return json({ error: 'custody service temporarily unavailable — request a new code and try again' }, 503);
    }
  }

  let agent: CanonicalAgentId;
  let custodyGrade: boolean;
  if (kms.ok && (!facet || facet.toLowerCase() === kms.agentId.toLowerCase())) {
    // The phone's OWN KMS home — fresh bootstrap OR returning (deterministic SA; the client deploys it +
    // then prompts a passkey as the durable credential). Refresh the facet (idempotent; tracks rotation).
    await recordPhoneFacet(env.AUTH_CODES, phone, kms.agentId);
    agent = kms.agentId;
    custodyGrade = true;
  } else if (facet) {
    // Phone was LINKED to another home (e.g. a passkey home). Respect the link: login-grade session only —
    // phone (contact-control) never confers custody OVER a device-secured home (ADR-0011).
    console.warn('[phone-verify] login-grade session (facet-linked home)', { facet, kmsOk: kms.ok, kmsAgent: kms.ok ? kms.agentId : null, reason: kms.ok ? 'facet != kms home' : (kms as { reason?: string }).reason });
    agent = facet;
    custodyGrade = false;
  } else {
    // No home + custody ineligible/unreachable → the client onboards with a passkey/Google first.
    return json({ status: 'bootstrap', via: 'phone' });
  }

  const sessionPrincipal: CredentialPrincipal = custodyGrade
    ? { kind: 'oidc', id: oidcFacetId(PHONE_ISS, hash), assurance: 'onchain-confirmed', role: 'custody-grade' }
    : { kind: 'phone', id: hash, assurance: 'asserted', role: 'login-grade' };
  const token = await mintAgentSession(
    {
      sub: agent,
      principal: sessionPrincipal,
      assurance: custodyGrade ? 'onchain-confirmed' : 'asserted',
      aud: custodyGrade ? custodyAud : rec.aud,
      iss,
      ttlSeconds: 3600,
      ...(custodyGrade ? { rotation } : {}),
    },
    signer,
  );
  // `custody:true` → the client secures the home on-chain (secureHomeNoName) THEN prompts a passkey.
  return json({ status: 'issued', token, via: 'phone', custody: custodyGrade });
};
