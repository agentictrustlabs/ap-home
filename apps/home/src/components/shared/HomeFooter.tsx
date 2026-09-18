// THE HOME'S FOOTER — where this Home's substrate, its ontologies and its maker live (whitelabel.footer).
//
// Cross-links, not a menu: the one route of the Home here is /about (the public page a crawler reads first);
// every other link is outbound to a site of ours.
// Rendered under every portal section (scrolls with the content — it never competes with the bottom nav) and
// under the sign-in card, so a person and a search engine both find the substrate from any page of a Home.
import { whitelabel } from '../../whitelabel/config';

export function HomeFooter({ compact }: { compact?: boolean }) {
  const { credit, links } = whitelabel.footer;
  return (
    <footer className={compact ? 'home-footer home-footer-compact' : 'home-footer'} data-testid="home-footer">
      <span className="home-footer-credit">{credit}</span>
      <nav aria-label="About this Home, its substrate and its studio" className="home-footer-links">
        <a href="/about">About {whitelabel.brand.name}</a>
        {links.map((l) => (
          <a key={l.href} href={l.href} rel={l.rel ?? 'noopener'} target="_blank">{l.label}</a>
        ))}
      </nav>
      <span className="home-footer-brand">{whitelabel.brand.name} · a Home on the Agentic Primitives substrate</span>
    </footer>
  );
}
