import { describe, expect, it } from 'vitest';
import { footerLinks, whitelabel } from './config';

describe('the Home footer (whitelabel.footer)', () => {
  it('links outbound to the substrate, its ontologies, the skills library and the studio by default', () => {
    const hrefs = whitelabel.footer.links.map((l) => l.href);
    expect(hrefs).toContain('https://agenticprimitives.dev');
    expect(hrefs).toContain('https://agenticprimitives.dev/ontology');
    expect(hrefs).toContain('https://skills.faithnet.io');
    expect(hrefs).toContain('https://richcanvas3.com');
    expect(hrefs.every((h) => h.startsWith('https://'))).toBe(true);
  });
  it('a deployment replaces the set with NEXT_PUBLIC_FOOTER_LINKS, and a malformed value is refused, never swapped for the defaults', () => {
    const d = [{ label: 'x', href: 'https://x.example' }];
    expect(footerLinks(undefined, d)).toBe(d);
    expect(footerLinks('  ', d)).toBe(d);
    expect(footerLinks('[{"label":"Docs","href":"https://docs.example"}]', d)).toEqual([{ label: 'Docs', href: 'https://docs.example' }]);
    expect(() => footerLinks('not json', d)).toThrow(/not JSON/);
    expect(() => footerLinks('[{"label":"x","href":"http://insecure.example"}]', d)).toThrow(/https/);
    expect(() => footerLinks('{"label":"x"}', d)).toThrow(/array/);
  });
});
