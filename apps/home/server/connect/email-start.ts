// POST /connect/email/start — send a one-time 6-digit code to an email (email-auth, login-grade).
//   body: { email, aud? }
// The OTP record is keyed by SHA-256(email) (NOT the code — so a code can't be brute-forced blindly;
// verification requires knowing the email, and per-email attempts are bounded in email-verify). The raw
// email is never stored. Deploy-safe: with no SendGrid key the sender logs (no send), still returns ok.
import type { FnContext } from '../_lib/server-broker';
import { sendEmail, otpEmail, emailSendingEnabled } from '../_lib/email-sender';
import { emailHash } from '../../src/lib/kv-indexer';
import { whitelabel } from '../../src/whitelabel/config';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 6-digit cryptographically-random code. */
function newOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { email?: string; aud?: string } | null;
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: 'a valid email is required' }, 400);

  const code = newOtp();
  const key = `emailotp:${await emailHash(email)}`;
  await env.AUTH_CODES.put(
    key,
    JSON.stringify({ code, aud: body?.aud ?? env.DEMO_SSO_AUD ?? 'demo-sso', attempts: 0 }),
    { expirationTtl: 600 }, // 10 minutes
  );

  const sent = await sendEmail(env, otpEmail(email, code, whitelabel.brand.name));
  if (!sent.ok) return json({ error: `could not send the code: ${sent.error}` }, 502);
  // `delivery:'logged'` tells the client (dev) the code was console-logged, not emailed (no provider key).
  // Testing convenience: echo the code when UNCONFIGURED + DEV_OTP_ECHO=true (a real SendGrid key never echoes).
  const echo = !emailSendingEnabled(env) && env.DEV_OTP_ECHO === 'true';
  return json({ ok: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', ...(echo ? { devCode: code } : {}) });
};
