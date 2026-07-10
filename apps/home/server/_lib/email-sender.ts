// Swappable email sender (email-auth OTP + org invite links). Gated + DEPLOY-SAFE: with no provider
// key set, it LOGS the message and returns ok — the build/flows never break; set SENDGRID_API_KEY +
// EMAIL_FROM (a verified sender) to send for real. Uses the SendGrid v3 REST API directly (no npm dep →
// provider stays swappable, build stays lean).
export interface EmailEnv {
  SENDGRID_API_KEY?: string;
  /** Verified sender, e.g. `no-reply@impact-agent.me` — REQUIRED by SendGrid (must be a verified sender/domain). */
  EMAIL_FROM?: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** True once a provider is configured — the UI shows "email login/invite available" only when this is set. */
export function emailSendingEnabled(env: EmailEnv): boolean {
  return !!(env.SENDGRID_API_KEY && env.SENDGRID_API_KEY.trim() && env.EMAIL_FROM && env.EMAIL_FROM.trim());
}

export async function sendEmail(env: EmailEnv, msg: OutboundEmail): Promise<{ ok: boolean; error?: string }> {
  const key = env.SENDGRID_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!key || !from) {
    // No provider → don't fail; log so a dev can grab the OTP/link locally (deploy-safe).
    console.log(`[email-sender] (SENDGRID_API_KEY/EMAIL_FROM unset) would send to ${msg.to} — "${msg.subject}"`);
    return { ok: true };
  }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from },
        subject: msg.subject,
        content: [
          ...(msg.text ? [{ type: 'text/plain', value: msg.text }] : []),
          { type: 'text/html', value: msg.html },
        ],
      }),
    });
    // SendGrid returns 202 Accepted on success.
    if (!res.ok) return { ok: false, error: `sendgrid ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'email send failed' };
  }
}

const wrap = (inner: string, brand: string): string =>
  `<div style="font-family:system-ui,sans-serif;max-width:440px;margin:auto;padding:24px">
     <p style="font-size:13px;color:#6b7280;margin:0 0 16px">${brand}</p>${inner}
     <p style="font-size:12px;color:#9ca3af;margin-top:24px">If you didn't request this, you can ignore this email.</p>
   </div>`;

export function otpEmail(to: string, otp: string, brand: string): OutboundEmail {
  return {
    to,
    subject: `${otp} is your ${brand} sign-in code`,
    text: `Your ${brand} sign-in code is ${otp}. It expires in 10 minutes.`,
    html: wrap(`<p style="font-size:15px">Your sign-in code:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:4px;margin:8px 0">${otp}</p>
      <p style="font-size:13px;color:#6b7280">Expires in 10 minutes.</p>`, brand),
  };
}

export function inviteEmail(to: string, joinUrl: string, orgName: string, brand: string): OutboundEmail {
  return {
    to,
    subject: `You're invited to join ${orgName}`,
    text: `You've been invited to join ${orgName} on ${brand}. Join here: ${joinUrl}`,
    html: wrap(`<p style="font-size:15px"><b>You're invited to join ${orgName}.</b></p>
      <p style="font-size:13px;color:#6b7280;margin:8px 0 16px">Click below to accept — you'll confirm your email, then join.</p>
      <a href="${joinUrl}" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Accept invitation</a>`, brand),
  };
}
