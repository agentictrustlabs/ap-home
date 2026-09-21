import { describe, expect, it } from 'vitest';
import { PRIVATE_PATH_PREFIXES, PUBLIC_ROUTES, SITE_ORIGIN, absoluteUrl, siteJsonLd } from './site';

describe('what a search engine may know about a Home (src/seo/site.ts)', () => {
  it('names one https origin and builds every public URL on it', () => {
    expect(SITE_ORIGIN).toMatch(/^https:\/\/[^/]+$/);
    for (const r of PUBLIC_ROUTES) expect(absoluteUrl(r.path)).toBe(`${SITE_ORIGIN}${r.path}`);
    expect(absoluteUrl('about')).toBe(`${SITE_ORIGIN}/about`);
  });
  it('invites the front door, About, the public shelf (412) and llms.txt — and nothing that is private', () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    expect(paths).toEqual(['/', '/about', '/published', '/llms.txt']);
    for (const p of paths) for (const priv of PRIVATE_PATH_PREFIXES) expect(p.startsWith(priv)).toBe(false);
    // the machine doors and the session paths are all disallowed
    for (const must of ['/me/', '/connect/', '/oidc/', '/token', '/jwks', '/a2a/', '/registry']) expect(PRIVATE_PATH_PREFIXES).toContain(must);
  });
  it('structured data says what the site is and links only to sites of ours', () => {
    const ld = siteJsonLd() as { '@graph': Array<Record<string, unknown>> };
    const types = ld['@graph'].map((n) => n['@type']);
    expect(types).toEqual(['WebSite', 'Organization', 'SoftwareApplication']);
    const org = ld['@graph'][1] as { sameAs: string[] };
    expect(org.sameAs).toContain('https://agenticprimitives.dev');
    expect(org.sameAs.every((u) => u.startsWith('https://'))).toBe(true);
    expect(JSON.stringify(ld)).not.toContain('</script');
  });
});
