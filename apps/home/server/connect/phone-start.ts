// POST /connect/phone/start — begin phone (SMS) verification (phone-auth, login-grade; spec 320).
//   body: { phone, aud? }  → { ok, delivery }
// Twilio Verify sends + manages the OTP (we store NO code when configured). The `aud` context is stashed
// keyed by SHA-256(E.164) so the verify step knows the requesting audience. The raw number is never stored.
// DEPLOY-SAFE: with Twilio unset, we self-generate a dev OTP (stored + logged) so the flow still works.
import type { FnContext } from '../_lib/server-broker';
import { sendPhoneVerification, smsVerifyEnabled, normalizeE164 } from '../_lib/sms-sender';
import { phoneHash } from '../../src/lib/kv-indexer';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

/** 6-digit cryptographically-random dev code (used ONLY when Twilio Verify is unconfigured). */
function devOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { phone?: string; aud?: string } | null;
  const phone = normalizeE164(body?.phone ?? '');
  if (!phone) return json({ error: 'a valid phone number (E.164, e.g. +13035551234) is required' }, 400);

  const aud = body?.aud ?? env.DEMO_SSO_AUD ?? 'demo-sso';
  const key = `phoneverify:${await phoneHash(phone)}`;
  const twilio = smsVerifyEnabled(env);

  if (twilio) {
    // Twilio owns the code — we stash only the aud (+ provider) so verify knows how to check.
    await env.AUTH_CODES.put(key, JSON.stringify({ aud, provider: 'twilio' }), { expirationTtl: 600 });
  } else {
    // Dev fallback: self-generate + store the code (logged by the sender), verified locally.
    const code = devOtp();
    await env.AUTH_CODES.put(key, JSON.stringify({ aud, provider: 'dev', code, attempts: 0 }), { expirationTtl: 600 });
    console.log(`[phone-start] (dev) OTP for ${phone} = ${code}`);
  }

  const sent = await sendPhoneVerification(env, phone);
  if (!sent.ok) return json({ error: `could not send the code: ${sent.error}` }, 502);
  return json({ ok: true, delivery: twilio ? 'sent' : 'logged' });
};
