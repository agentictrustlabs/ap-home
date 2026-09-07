// THE EMAIL CHANNEL — spec 365, the app half.
//
// The port and the rules live in `@agenticprimitives/fabric/email`; the PROVIDERS live here, because a
// transport is a leaf binding that depends inward (ADR-0057) and the substrate must not know whether a
// deployment sends through an HTTP API or a platform binding.
//
// TWO INTEGRATIONS, deliberately:
//   · CLOUDFLARE EMAIL — the `send_email` binding, and the only rail that can also RECEIVE (Email
//     Routing calls this Worker's `email()` handler). Its honest limitation: a Worker may only send to
//     addresses verified in the account, so it is right for replies and estate mail and wrong for
//     inviting a stranger.
//   · SENDGRID — an HTTP API that will send to anyone, which is what an invitation needs.
// Both behind one port, so a caller asks for "email" and the deployment decides which rail carries it.
import {
  firstAvailableSender, handleFromAddress, inboundEmailToMessage, isEmailAddress,
  type EmailSenderPort, type InboundEmailV1, type OutboundEmailV1,
} from '@agenticprimitives/fabric/email';

/** The bindings and secrets the two providers need. All optional: email is a capability a deployment
 *  HAS or does not, and the surfaces ask before they offer it. */
export interface EmailEnv {
  /** Cloudflare Email binding (`[[send_email]]`). Present only where the account has it configured. */
  SEND_EMAIL?: { send(msg: unknown): Promise<void> };
  SENDGRID_API_KEY?: string;
  /** The verified sender address mail goes out as. Required by both rails. */
  EMAIL_FROM?: string;
  /** The zones whose mail this deployment answers for, comma-separated (`faithnet.me`). */
  EMAIL_ZONES?: string;
}

/** RFC 5322 the smallest way that is honest: a single-part text message with the headers we set. */
function rawMessage(from: string, msg: OutboundEmailV1): string {
  const lines = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`, `References: ${msg.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    msg.text,
  ];
  return lines.join('\r\n');
}

export function cloudflareSender(env: EmailEnv): EmailSenderPort {
  return {
    name: 'cloudflare',
    available: () => !!env.SEND_EMAIL && !!env.EMAIL_FROM?.trim(),
    async send(msg) {
      const from = env.EMAIL_FROM!.trim();
      try {
        // The binding takes an EmailMessage; constructing it needs the runtime's own class, which only
        // exists in the Worker. Imported dynamically so this module still loads (and tests) elsewhere.
        const mod = await import('cloudflare:email') as { EmailMessage: new (from: string, to: string, raw: string) => unknown };
        await env.SEND_EMAIL!.send(new mod.EmailMessage(from, msg.to, rawMessage(from, msg)));
        return { ok: true, via: 'cloudflare' };
      } catch (e) {
        // The usual refusal here is a destination the account has not verified — say that, because it is
        // fixable and "email failed" is not.
        const why = e instanceof Error ? e.message : String(e);
        return { ok: false, via: 'cloudflare', error: /verif/i.test(why) ? `${msg.to} is not a verified destination for this account` : why };
      }
    },
  };
}

export function sendgridSender(env: EmailEnv): EmailSenderPort {
  return {
    name: 'sendgrid',
    available: () => !!env.SENDGRID_API_KEY?.trim() && !!env.EMAIL_FROM?.trim(),
    async send(msg) {
      try {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SENDGRID_API_KEY!.trim()}` },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: msg.to }] }],
            from: { email: env.EMAIL_FROM!.trim() },
            subject: msg.subject,
            content: [{ type: 'text/plain', value: msg.text }, ...(msg.html ? [{ type: 'text/html', value: msg.html }] : [])],
          }),
        });
        if (!res.ok) return { ok: false, via: 'sendgrid', error: `sendgrid ${res.status}` };
        return { ok: true, via: 'sendgrid', ...(res.headers.get('x-message-id') ? { messageId: res.headers.get('x-message-id')! } : {}) };
      } catch (e) {
        return { ok: false, via: 'sendgrid', error: e instanceof Error ? e.message : 'send failed' };
      }
    },
  };
}

/**
 * The rail this deployment sends on, or null.
 *
 * ORDER IS A STATED PREFERENCE, not a fallback: SendGrid first because it reaches ANY address, which is
 * what an invitation needs; Cloudflare second because it is bound to verified destinations. A configured
 * provider that fails returns its error — nothing is re-sent down the other rail, because a message
 * delivered twice is worse than one that reports it did not go.
 */
export function emailSender(env: EmailEnv): EmailSenderPort | null {
  return firstAvailableSender([sendgridSender(env), cloudflareSender(env)]);
}

export function emailZones(env: EmailEnv): string[] {
  return (env.EMAIL_ZONES ?? '').split(',').map((z) => z.trim().toLowerCase()).filter(Boolean);
}

/** What the inbound handler needs from the app, injected so this file stays testable and thin. */
export interface InboundDeps {
  /** `alice` → her agent address, from the naming service. Null when nobody holds the name. */
  resolveHandle: (handle: string) => Promise<string | null>;
  /** Admit a message into the recipient's own inbox. The ONE thing inbound mail may do. */
  admit: (input: { recipient: string; subject: string; bodyText: string; claimedFrom: string; messageId?: string }) => Promise<{ ok: boolean; error?: string }>;
}

export type InboundOutcome =
  | { ok: true; recipient: string }
  | { ok: false; reason: 'not-our-zone' | 'no-such-agent' | 'not-admitted'; detail?: string };

/**
 * AN EMAIL ARRIVES — spec 365 rule 1: it becomes a MESSAGE and can never become an act.
 *
 * Routed by the address it was sent TO, resolved through the naming service. A name nobody holds is a
 * refusal, not a guess at the nearest one: delivering a stranger's mail to whoever has a similar handle
 * is the worst thing this path could do.
 *
 * There is deliberately no branch here that reads the body for instructions. Everything a person can do
 * from the resulting thread, they do from their own surface, under their own mandate.
 */
export async function admitInboundEmail(mail: InboundEmailV1, zones: readonly string[], deps: InboundDeps): Promise<InboundOutcome> {
  const handle = handleFromAddress(mail.to, zones);
  if (!handle) return { ok: false, reason: 'not-our-zone' };
  const agent = await deps.resolveHandle(handle).catch(() => null);
  if (!agent) return { ok: false, reason: 'no-such-agent', detail: handle };
  const shaped = inboundEmailToMessage(mail);
  const out = await deps.admit({
    recipient: agent.toLowerCase(),
    subject: shaped.subject,
    bodyText: shaped.bodyText,
    claimedFrom: shaped.claimedFrom,
    ...(mail.messageId ? { messageId: mail.messageId } : {}),
  });
  return out.ok ? { ok: true, recipient: agent.toLowerCase() } : { ok: false, reason: 'not-admitted', ...(out.error ? { detail: out.error } : {}) };
}

export { isEmailAddress };
