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
  /** Account SID (AC…) — needed in the Programmable Messaging URL path. */
  TWILIO_ACCOUNT_SID?: string;
  /** A Twilio phone number you own (+1…) OR a Messaging Service SID (MG…) — the SMS `From`. A trial
   *  account gets one free number and can text your own VERIFIED number without a Verify upgrade. */
  TWILIO_FROM_NUMBER?: string;
}

/** True once Twilio VERIFY (managed OTP) is configured — the caller uses Twilio's OTP. */
export function smsVerifyEnabled(env: TwilioEnv): boolean {
  return !!(env.TWILIO_API_KEY?.trim() && env.TWILIO_API_KEY_SECRET?.trim() && env.TWILIO_VERIFY_SERVICE_SID?.trim());
}

/** True once Twilio Programmable MESSAGING is configured — the caller texts OUR OWN dev OTP (no Verify
 *  service / upgrade needed; a trial account can send to a verified number). Requires account SID + a From. */
export function smsMessagingEnabled(env: TwilioEnv): boolean {
  return !!(env.TWILIO_ACCOUNT_SID?.trim() && env.TWILIO_API_KEY?.trim() && env.TWILIO_API_KEY_SECRET?.trim() && env.TWILIO_FROM_NUMBER?.trim());
}

const authHeader = (env: TwilioEnv): string =>
  'Basic ' + btoa(`${env.TWILIO_API_KEY?.trim()}:${env.TWILIO_API_KEY_SECRET?.trim()}`);

/** A safe, actionable hint for a 401 based on the credential TYPE prefix (never the value). Twilio Basic
 *  auth wants either an API Key SID (`SK…`)+secret OR the Account SID (`AC…`)+Auth Token. */
function credHint(env: TwilioEnv): string {
  const key = (env.TWILIO_API_KEY ?? '').trim();
  const svc = (env.TWILIO_VERIFY_SERVICE_SID ?? '').trim();
  if (!svc.startsWith('VA')) return `TWILIO_VERIFY_SERVICE_SID should start with "VA" (got "${svc.slice(0, 2)}…")`;
  if (key.startsWith('SK')) return 'TWILIO_API_KEY (SK…) is an API key — recheck TWILIO_API_KEY_SECRET (Twilio shows it once; create a new key if lost)';
  if (key.startsWith('AC')) return 'TWILIO_API_KEY is your Account SID (AC…) — then TWILIO_API_KEY_SECRET must be your Auth Token (not an API-key secret)';
  return `TWILIO_API_KEY must start with "SK" (API key) or "AC" (Account SID) — got "${key.slice(0, 2)}…"`;
}
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
      // Surface Twilio's own message (JSON body) or raw text, PLUS a credential-format hint — a 401 almost
      // always means TWILIO_API_KEY holds the Account SID (AC…) instead of an API Key SID (SK…), or the
      // secret is wrong. We only echo the 2-char credential TYPE prefix, never the value.
      const detail = await res.text().catch(() => '');
      const twMsg = (() => { try { return (JSON.parse(detail) as { message?: string }).message; } catch { return detail.slice(0, 120); } })();
      return { ok: false, error: `twilio verify ${res.status}${twMsg ? `: ${twMsg}` : ''}${res.status === 401 ? ` — ${credHint(env)}` : ''}` };
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

/** Twilio Programmable Messaging: send a plain SMS (used to deliver OUR OWN dev OTP without Verify). Auth
 *  is the same API key (or Account SID + Auth Token); the Account SID scopes the URL. `From` is a Twilio
 *  number (+1…) or a Messaging Service SID (MG…). Only called when `smsMessagingEnabled`. */
export async function sendSms(env: TwilioEnv, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const from = env.TWILIO_FROM_NUMBER?.trim() ?? '';
  const params = new URLSearchParams({ To: to, Body: body });
  // A Messaging Service SID (MG…) goes in `MessagingServiceSid`; a plain number goes in `From`.
  if (from.startsWith('MG')) params.set('MessagingServiceSid', from);
  else params.set('From', from);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID?.trim()}/Messages.json`, {
      method: 'POST',
      headers: { authorization: authHeader(env), 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const twMsg = (() => { try { return (JSON.parse(detail) as { message?: string }).message; } catch { return detail.slice(0, 160); } })();
      return { ok: false, error: `twilio sms ${res.status}${twMsg ? `: ${twMsg}` : ''}${res.status === 401 ? ` — ${credHint(env)}` : ''}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'sms send failed' };
  }
}

/** Normalize a user-entered phone number to E.164 (`+<country><number>`, 8–15 digits). Identity is ALWAYS
 *  keyed on this canonical form, never the display format. Returns null when it isn't a plausible E.164. */
export function normalizeE164(raw: string): string | null {
  const s = (raw ?? '').trim().replace(/[^\d+]/g, '');
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
