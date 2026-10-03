/**
 * The Messages deep link: `/messages?to=<name|0x…>[&text=<words>]`.
 *
 * `to` opens compose to that recipient (the messaging-wire approval follows). `text`, only alongside a
 * valid `to`, PROPOSES a first message: it seeds the compose box and is never sent on its own — the
 * person reads it and presses Send.
 *
 * WHY a relying app hands over words this way: the skills app's "Propose a skill for this domain"
 * routes the request to the domain organization through here, because the Home is where the person's
 * messaging authority is approved (a ceremony — skills CLAUDE.md "Home is for ceremonies"). The app
 * may suggest the words; only the person's Send, under their own approval, delivers them.
 */

export const DEEP_LINK_TEXT_MAX = 2000;

export type MessageDeepLink = { to: string; text: string | null };

// C0 (except \t and \n), DEL, C1, and the bidi embedding/override/isolate controls — a seeded draft is
// text a third party chose, so nothing in it may reorder or hide what the person is about to send.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** Strip control characters, trim, and cap at `max` code points (a cut ends in "…", within the cap). */
export function sanitizeDeepLinkText(raw: string, max = DEEP_LINK_TEXT_MAX): string {
  const clean = raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Parse `?to=…&text=…`. No `to` → null (a `text` alone is ignored); an empty `text` → `text: null`. */
export function parseMessageDeepLink(search: string | URLSearchParams): MessageDeepLink | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const to = params.get('to')?.trim().toLowerCase();
  if (!to) return null;
  const rawText = params.get('text');
  const text = rawText == null ? null : sanitizeDeepLinkText(rawText);
  return { to, text: text ? text : null };
}
