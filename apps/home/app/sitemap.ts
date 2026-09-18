// /sitemap.xml — the public routes of a Home, absolute on the canonical origin (src/seo/site.ts). Submit this
// URL in Google Search Console; robots.txt also names it, so a crawler finds it without being told.
import type { MetadataRoute } from 'next';
import { PUBLIC_ROUTES, absoluteUrl } from '../src/seo/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PUBLIC_ROUTES.map((r) => ({ url: absoluteUrl(r.path), lastModified, changeFrequency: r.changeFrequency, priority: r.priority }));
}
