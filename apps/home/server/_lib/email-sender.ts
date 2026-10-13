// The Home's outbound email (email-auth OTP + org invite links). ONE RAIL: the a2a Worker's Cloudflare Email
// Service binding (spec 365). With it unconfigured the message is LOGGED and the call returns ok, so a local
// developer can read the OTP out of the console and no flow breaks on a machine with no mail.
//
// SENDGRID IS GONE (2026-10-13, the owner's decision). It had been the "deployment without the binding" path
// and was never provisioned anywhere: no `SENDGRID_API_KEY` existed in any Worker environment on either estate
// or in any Vercel environment, so the branch was unreachable in every deployment we run. A second mechanism
// that nobody configures is not a fallback, it is a thing to maintain and a place for a reader to think mail
// might come from (ADR-0013: one mechanism per read, and one per write).
import { signBridgeCall } from './bridge-hmac';

export interface EmailEnv {
  /** The a2a Worker that holds the Cloudflare Email Service binding (spec 365). When set, EVERY mail this
   *  Home sends goes out through its `/email/send`: as a person or an organization under their session, or
   *  as system mail (a sign-in code) under the HMAC bridge envelope the custody routes already use. */
  A2A_CUSTODY_URL?: string;
  A2A_CUSTODY_BRIDGE_SECRET?: string;
  /** The address mail goes out as, e.g. `invites@faithnet.ai` — a zone onboarded to Email Sending. */
  EMAIL_FROM?: string;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** True once the rail is configured — the UI shows "email login/invite available" only when this is set. */
export function emailSendingEnabled(env: EmailEnv): boolean {
  return !!(env.A2A_CUSTODY_URL?.trim() && env.A2A_CUSTODY_BRIDGE_SECRET?.trim());
}

/** Who the mail goes out as, when a steward sends it for an organization through the Worker rail. */
export interface SendAs { session: string; as: string }

export async function sendEmail(env: EmailEnv, msg: OutboundEmail, sendAs?: SendAs): Promise<{ ok: boolean; error?: string }> {
  // THE WORKER RAIL (Cloudflare Email Service) — the one rail. This Home runs where no email binding exists;
  // the a2a Worker holds one, sends from a zone onboarded to Email Sending, and threads a person's or
  // organization's copy into their own inbox. A person's mail carries their session; system mail (a sign-in
  // code, a verification) carries the HMAC bridge envelope.
  const a2a = env.A2A_CUSTODY_URL?.trim();
  if (a2a && env.A2A_CUSTODY_BRIDGE_SECRET?.trim()) {
    try {
      const payload = { to: msg.to, subject: msg.subject, text: msg.text ?? '', ...(msg.html ? { html: msg.html } : {}) };
      const url = `${a2a.replace(/\/$/, '')}/email/send`;
      const r = sendAs
        ? await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, session: sendAs.session, as: sendAs.as }) })
        : await (async () => {
            const envelope = await signBridgeCall({ secret: env.A2A_CUSTODY_BRIDGE_SECRET!, audience: 'email.send', payload });
            return fetch(url, { method: 'POST', headers: envelope.headers, body: envelope.body });
          })();
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; via?: string };
      if (!r.ok || body.ok === false) return { ok: false, error: body.error ?? `worker email ${r.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'email send failed' };
    }
  }
  // No rail configured — a local machine. Log it so a developer can read the code out of the console, and
  // return ok so the flow under test is the flow, not the mail.
  console.log(`[email-sender] (A2A_CUSTODY_URL/BRIDGE_SECRET unset) would send to ${msg.to} — "${msg.subject}"`);
  return { ok: true };
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

/** `appName` names the relying app this invitation is TO — the org is the community inside it. */
export function inviteEmail(to: string, joinUrl: string, orgName: string, brand: string, appName?: string | null, declineUrl?: string | null): OutboundEmail {
  const subject = appName ? `You're invited to ${appName} (${orgName})` : `You're invited to join ${orgName}`;
  const lead = appName
    ? `You've been invited to ${appName} to join ${orgName}.`
    : `You've been invited to join ${orgName} on ${brand}.`;
  const detail = appName
    ? `Click below to accept — we'll set up your home, then take you to ${appName} as a member of ${orgName}.`
    : `Click below to accept — you'll confirm your email, choose the name your team sees, then join.`;
  return {
    to,
    subject,
    text: `${lead} ${detail} Join here: ${joinUrl}${declineUrl ? `\n\nNot interested? ${declineUrl}` : ''}`,
    html: wrap(`<p style="font-size:15px"><b>${lead}</b></p>
      <p style="font-size:13px;color:#6b7280;margin:8px 0 16px">${detail}</p>
      <a href="${joinUrl}" style="display:inline-block;background:#4338ca;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Accept invitation</a>${declineUrl ? `
      <p style="font-size:11px;color:#9ca3af;margin-top:28px"><a href="${declineUrl}" style="color:#9ca3af;text-decoration:underline">Not interested</a></p>` : ''}`, brand),
  };
}
