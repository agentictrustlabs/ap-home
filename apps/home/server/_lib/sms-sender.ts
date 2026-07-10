// Swappable phone-verification transport (phone-auth OTP bootstrap, spec 320). Uses Twilio VERIFY — the
// managed OTP product (Twilio generates/expires/rate-limits the code + delivers the SMS); we NEVER hand-roll
// SMS OTP, and NEVER use SendGrid (that's the email product). Twilio Verify is called over its v2 REST API
// directly (no `twilio` npm dep → provider stays swappable, build stays lean).
//
// DEPLOY-SAFE: with no Twilio key set, `smsVerifyEnabled` is false and the caller (phone-start/phone-verify)
// falls back to a self-generated dev OTP (logged, exactly like email's unconfigured path) so flows never
// break. API keys (SK…/secret), not the master Auth Token, per Twilio's production guidance.
export interface TwilioEnv {
  TWILIO_API_KEY?: string;
  TWILIO_API_KEY_SECRET?: string;
  /** Verify Service SID (VA…) — the configured Verify service that owns templating + rate limits. */
  TWILIO_VERIFY_SERVICE_SID?: string;
}

/** True once Twilio Verify is configured — the caller uses the managed OTP; otherwise a dev OTP fallback. */
export function smsVerifyEnabled(env: TwilioEnv): boolean {
  return !!(env.TWILIO_API_KEY?.trim() && env.TWILIO_API_KEY_SECRET?.trim() && env.TWILIO_VERIFY_SERVICE_SID?.trim());
}

const authHeader = (env: TwilioEnv): string =>
  'Basic ' + btoa(`${env.TWILIO_API_KEY?.trim()}:${env.TWILIO_API_KEY_SECRET?.trim()}`);
const verifyBase = (env: TwilioEnv): string =>
  `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID?.trim()}`;

/** Twilio Verify: create a verification → sends an SMS OTP to `phoneE164`. Returns ok even when Twilio
 *  is unconfigured (the caller then uses a dev OTP). `phoneE164` MUST be pre-normalized to E.164. */
export async function sendPhoneVerification(env: TwilioEnv, phoneE164: string): Promise<{ ok: boolean; error?: string }> {
  if (!smsVerifyEnabled(env)) {
    console.log(`[sms-sender] (TWILIO_* unset) would send SMS code to ${phoneE164} — using dev OTP fallback`);
    return { ok: true };
  }
  try {
    const res = await fetch(`${verifyBase(env)}/Verifications`, {
      method: 'POST',
      headers: { authorization: authHeader(env), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phoneE164, Channel: 'sms' }).toString(),
    });
    if (!res.ok) {
      // Surface Twilio's own message (e.g. "Authentication Error - invalid username") — a 401 means the
      // API key SID (SK…) / secret is wrong, or the Account SID was used where an API key is expected.
      const detail = (await res.json().catch(() => null)) as { message?: string; code?: number } | null;
      return { ok: false, error: `twilio verify ${res.status}${detail?.message ? `: ${detail.message}` : ''}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'sms send failed' };
  }
}

/** Twilio Verify: check a submitted code → `approved` on success. Only called when `smsVerifyEnabled`. */
export async function checkPhoneVerification(
  env: TwilioEnv,
  phoneE164: string,
  code: string,
): Promise<{ approved: boolean; error?: string }> {
  try {
    const res = await fetch(`${verifyBase(env)}/VerificationCheck`, {
      method: 'POST',
      headers: { authorization: authHeader(env), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phoneE164, Code: code }).toString(),
    });
    // A wrong/expired code returns 404 (no pending verification) or status !== 'approved'.
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      return { approved: false, error: `twilio check ${res.status}${detail?.message ? `: ${detail.message}` : ''}` };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { approved: body.status === 'approved' };
  } catch (e) {
    return { approved: false, error: e instanceof Error ? e.message : 'sms check failed' };
  }
}

/** Normalize a user-entered phone number to E.164 (`+<country><number>`, 8–15 digits). Identity is ALWAYS
 *  keyed on this canonical form, never the display format. Returns null when it isn't a plausible E.164. */
export function normalizeE164(raw: string): string | null {
  const s = (raw ?? '').trim().replace(/[^\d+]/g, '');
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
