// /robots.txt — the crawl rule, from the same list the sitemap and the noindex headers read (src/seo/site.ts).
import type { MetadataRoute } from 'next';
import { PRIVATE_PATH_PREFIXES, SITE_ORIGIN } from '../src/seo/site';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/about', '/llms.txt'], disallow: [...PRIVATE_PATH_PREFIXES] }],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
