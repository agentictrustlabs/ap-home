// Personal-subdomain host context (spec 229 P5 + spec 232). The Connect SSO
// central auth is served at `impact-agent.me` (Vercel), and EACH person's secure
// home is their own single-label subdomain `<handle>.impact-agent.me`. The
// WebAuthn RP is the serving host, so a ROOT passkey created here is bound to
// (and isolated to) the person's own subdomain.
//
// NOTE the SSO/A2A SPLIT (spec 232): the human SSO home is `<handle>.impact-agent.me`
// (Vercel); the agent's A2A endpoint is a SEPARATE domain `<handle>.impact-agent.io`
// (Cloudflare demo-a2a Worker). Two faces of one `.agent` name, two TLDs.
//
// Apex `impact-agent.me` = the platform landing + bootstrap/sign-up origin (a
// name with no agent yet has no home to resolve to).

/** The registrable Connect SSO domain. Per-person homes are single-label subdomains. */
export const CENTRAL_AUTH_DOMAIN = 'impact-agent.me';

/** The platform (apex) Connect origin — landing + bootstrap default. */
export const PLATFORM_AUTH_ORIGIN = `https://${CENTRAL_AUTH_DOMAIN}`;

/**
 * Extract a single-label subdomain from a hostname given the base domain.
 * `alice.impact-agent.io` → `alice`. The apex, nested labels
 * (`a.b.impact-agent.io`), `www`, and non-matching hosts (pages.dev preview,
 * localhost dev) → `null`.
 */
export function parseAgentSubdomain(
  hostname: string,
  baseDomain: string = CENTRAL_AUTH_DOMAIN,
): string | null {
  const host = (hostname.split(':')[0] ?? '').toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base) return null;
  if (!host.endsWith('.' + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (!label || label.includes('.') || label === 'www') return null;
  return label;
}

/** The handle this page is serving as a personal home, or null on the apex / a
 *  non-central-auth host (pages.dev preview, localhost). On `alice.impact-agent.io`
 *  → `alice`. Drives the "this is <handle>'s secure home" framing + the
 *  subdomain-isolated passkey ceremony. */
export function subdomainHandle(): string | null {
  if (typeof window === 'undefined') return null;
  return parseAgentSubdomain(window.location.hostname);
}

/** The personal SSO origin for a name label
 *  (`alice` → `https://alice.impact-agent.me`). The ROOT-passkey home. */
export function personalAuthOrigin(label: string): string {
  return `https://${label}.${CENTRAL_AUTH_DOMAIN}`;
}
