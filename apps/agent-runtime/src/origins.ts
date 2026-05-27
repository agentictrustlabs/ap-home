// Origin / hostname allowlisting with ONE controlled wildcard form.
//
// An `ALLOWED_ORIGINS` entry is either:
//   - an exact origin  — "https://impact-agent.io", "http://localhost:5173"
//   - a single wildcard — "https://*.impact-agent.io" — which matches any
//     SINGLE-LABEL subdomain ("https://alice.impact-agent.io"). It does NOT
//     match the apex, and does NOT match nested labels ("a.b.impact-agent.io").
//
// Per-person subdomains (spec 231 — `<handle>.impact-agent.io` is one agent's
// unified SSO + A2A endpoint) are each a distinct browser Origin, so the
// exact-match CORS / CSRF / SIWE allowlists need this one controlled wildcard.
// The CSRF HMAC still binds each token to its mint origin (connect-auth
// `csrfTokenFor`), so widening the allowlist does NOT enable token forgery.
//
// Fail-closed: anything malformed or outside the patterns → no match.

const WILDCARD = '://*.';

interface WildcardPattern {
  scheme: string;
  base: string;
}

function splitPatterns(raw: Iterable<string>): { exact: string[]; wild: WildcardPattern[] } {
  const exact: string[] = [];
  const wild: WildcardPattern[] = [];
  for (const r of raw) {
    const p = r.trim();
    if (!p) continue;
    const i = p.indexOf(WILDCARD);
    if (i !== -1) {
      wild.push({ scheme: p.slice(0, i).toLowerCase(), base: p.slice(i + WILDCARD.length).toLowerCase() });
    } else {
      exact.push(p);
    }
  }
  return { exact, wild };
}

/** A single-label subdomain of `base` (alice.impact-agent.io of impact-agent.io)
 *  — not the apex, not nested (a.b.impact-agent.io). */
function isSingleLabelSubdomain(host: string, base: string): boolean {
  if (!host.endsWith('.' + base)) return false;
  const label = host.slice(0, host.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

/** True iff `origin` matches an exact entry or a `scheme://*.base` wildcard. */
export function originAllowed(origin: string | undefined | null, patterns: Iterable<string>): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const { exact, wild } = splitPatterns(patterns);
  for (const e of exact) {
    try {
      if (new URL(e).origin === u.origin) return true;
    } catch {
      /* skip malformed allowlist entry */
    }
  }
  const host = u.hostname.toLowerCase();
  for (const w of wild) {
    if (u.protocol === w.scheme + ':' && isSingleLabelSubdomain(host, w.base)) return true;
  }
  return false;
}

/** SIWE-domain variant: match a bare hostname against exact-entry hostnames or
 *  a wildcard base's single-label subdomains. */
export function hostnameAllowed(hostname: string | undefined | null, patterns: Iterable<string>): boolean {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  const { exact, wild } = splitPatterns(patterns);
  for (const e of exact) {
    try {
      if (new URL(e).hostname.toLowerCase() === host) return true;
    } catch {
      /* skip */
    }
  }
  for (const w of wild) {
    if (isSingleLabelSubdomain(host, w.base)) return true;
  }
  return false;
}
