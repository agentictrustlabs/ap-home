/** Same slug rule the relying apps use app-side: the `.impact` subregistry only accepts
 *  `[a-z0-9-]`, so normalize BEFORE the ceremony instead of failing at the name claim. */
export function toOrgLabel(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** First label of a hostname — `field-web.richardpedersen3.workers.dev` → `field-web`. */
export function shortAppHost(host: string): string {
  const h = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return h.split('.')[0] || h;
}

function looksLikeHost(value: string): boolean {
  const h = value.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!h) return false;
  if (h.includes('localhost') || h.startsWith('127.0.0.1')) return true;
  if (h.endsWith('.workers.dev') || h.endsWith('.pages.dev') || h.endsWith('.vercel.app')) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) && h.includes('.');
}

function humanizeHost(host: string): string {
  const short = shortAppHost(host);
  if (!short) return 'this app';
  return (
    short
      .replace(/-(web|app|ui|site)$/i, '')
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'this app'
  );
}

/**
 * Consent-screen name. A human registered name wins (anti-spoof). A workers.dev / pages.dev
 * hostname — even if someone stored it as the registered `name` — is never the title.
 */
export function displayAppName(registeredName: string | undefined, host: string): string {
  const named = registeredName?.trim();
  if (named && !looksLikeHost(named)) return named;
  return humanizeHost(named && looksLikeHost(named) ? named : host);
}

/** Quiet origin line — omitted for preview hosts that are not a public brand. */
export function displayAppDomain(host: string): string {
  const h = host.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!h) return '';
  if (h.includes('localhost') || h.startsWith('127.0.0.1')) return '';
  if (h.endsWith('.workers.dev') || h.endsWith('.pages.dev') || h.endsWith('.vercel.app')) return '';
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
