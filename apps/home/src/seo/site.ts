// WHAT A SEARCH ENGINE MAY KNOW ABOUT THIS HOME — the one place the public shape of the site is described.
//
// A Home is almost entirely private: every portal section renders a sign-in card to a visitor without a
// session, and the machine doors (`/me`, `/connect`, `/oidc`, `/token`, `/jwks`, `/registry`, …) are not pages.
// What a crawler is TOLD to index is therefore a short, explicit list — the front door, the About page and the
// coding agent's entrance (`/llms.txt`) — and everything else is named `noindex` (an `X-Robots-Tag` on the
// response, set from next.config from the same list) and disallowed in robots.txt. A private page that leaked
// into an index as "Sign in to Faithnet" would be a wrong answer about a person; the list keeps the index honest.
//
// The canonical origin is `NEXT_PUBLIC_HOME_ORIGIN` (src/lib/domain.ts): a Home reachable at both the apex and
// `www.` would otherwise index twice. Unset ⇒ the platform Connect origin, the one every other link is built on.
import { HOME_ORIGIN, PLATFORM_AUTH_ORIGIN } from '../lib/domain';
import { whitelabel } from '../whitelabel/config';

/** The ONE origin the sitemap, canonical links and structured data name. */
export const SITE_ORIGIN = (HOME_ORIGIN || PLATFORM_AUTH_ORIGIN).replace(/\/$/, '');

/** The routes a crawler is invited to: the front door, the About page, the coding agent's entrance. Each with
 *  how often it changes and how much it matters relative to the others (the sitemap's `changefreq`/`priority`). */
export const PUBLIC_ROUTES: ReadonlyArray<{ path: string; changeFrequency: 'weekly' | 'monthly'; priority: number }> = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8 },
  // Spec 412 — what the person made public, served by their agent; the one page of theirs a stranger may read.
  { path: '/published', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/llms.txt', changeFrequency: 'monthly', priority: 0.5 },
];

/** Every top-level path a crawler is told to stay out of. The portal sections and the machine doors are
 *  enumerated by next.config (it reads the app directory at build time and stamps `X-Robots-Tag: noindex`);
 *  robots.txt carries the same rule as prefixes so the crawl budget is not spent on sign-in cards. */
export const PRIVATE_PATH_PREFIXES: ReadonlyArray<string> = [
  '/me/', '/connect/', '/oidc/', '/token', '/jwks', '/handoff', '/link', '/invite', '/logout', '/fedcm',
  '/external-agent', '/choose-treasury', '/registry', '/a2a/',
];

/** The one-line description search results and link previews show. A deployment words its own with
 *  `NEXT_PUBLIC_SITE_DESCRIPTION`; the default names what a Home IS in the brand's terms. */
export const SITE_DESCRIPTION =
  process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
  `${whitelabel.brand.name} is your home in the ${whitelabel.brand.community}: one name, your own agent, your own records, and organizations you can act for — built on Agentic Primitives, where an agent's authority is a signed, scoped, revocable delegation it cannot exceed.`;

export const SITE_KEYWORDS: ReadonlyArray<string> = [
  whitelabel.brand.name, 'agentic primitives', 'personal agent', 'agent identity', 'delegated authority',
  'smart agent', 'ERC-4337', 'A2A', 'MCP', 'ontology', 'agent registry', 'digital home', whitelabel.brand.community,
];

/** Google Search Console's HTML-tag verification token (the `content` of `google-site-verification`), if the
 *  operator chose that method over the DNS record. Absent ⇒ no tag; nothing is guessed. */
export const GOOGLE_SITE_VERIFICATION = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || undefined;

export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

/** schema.org structured data for the front door and the About page: the site, the organization behind the
 *  brand, and the software it runs on — the three things a search engine asks "what is this?" about. Every
 *  URL in it is one of ours (the footer's cross-links, the substrate's own site). */
export function siteJsonLd(): Record<string, unknown> {
  const name = whitelabel.brand.name;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        url: `${SITE_ORIGIN}/`,
        name,
        description: SITE_DESCRIPTION,
        inLanguage: 'en',
        publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_ORIGIN}/#organization`,
        name,
        url: `${SITE_ORIGIN}/`,
        slogan: whitelabel.brand.tagline,
        sameAs: whitelabel.footer.links.map((l) => l.href),
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/#application`,
        name: `${name} Home`,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: `${SITE_ORIGIN}/`,
        description: SITE_DESCRIPTION,
        isBasedOn: { '@type': 'SoftwareSourceCode', name: 'Agentic Primitives', url: 'https://agenticprimitives.dev', codeRepository: 'https://github.com/agentictrustlabs/agenticprimitives' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  };
}
