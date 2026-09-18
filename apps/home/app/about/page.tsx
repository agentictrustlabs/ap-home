// /about — THE ONE PUBLIC PAGE THAT SAYS WHAT THIS HOME IS. Server-rendered, static, no session: the sign-in
// screen at `/` is a card and a footer, which is all a visitor without a session may see of a Home, and a search
// engine that finds only "Find your home" learns nothing. This page carries the plain description (what a Home
// is, how it holds a person's authority, who it is for, where a developer starts) with the same cross-links the
// footer carries, so the site is findable by what it does and not only by its name. Brand words come from the
// white-label config (ADR-0021); nothing here is a route of the portal and nothing here reads a record.
import type { Metadata } from 'next';
import { HomeFooter } from '../../src/components/shared/HomeFooter';
import { BrandShield } from '../../src/components/shared/BrandShield';
import { SITE_DESCRIPTION, absoluteUrl, siteJsonLd } from '../../src/seo/site';
import { whitelabel } from '../../src/whitelabel/config';

export const dynamic = 'force-static';

const brand = whitelabel.brand;

export const metadata: Metadata = {
  title: { absolute: `About ${brand.name} — ${brand.tagline}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: absoluteUrl('/about') },
  openGraph: { title: `About ${brand.name}`, description: SITE_DESCRIPTION, url: absoluteUrl('/about'), type: 'website' },
};

const SUBSTRATE = 'https://agenticprimitives.dev';

export default function AboutPage() {
  const jsonLd = JSON.stringify(siteJsonLd()).replace(/</g, '\\u003c');
  return (
    <div className="onboarding-screen about-screen">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <article className="about-page">
        <header className="about-hero">
          <BrandShield size={48} />
          <h1>{brand.name}</h1>
          <p className="about-tagline">{brand.tagline}</p>
          <p className="about-lede">{SITE_DESCRIPTION}</p>
          <p className="about-cta">
            <a className="about-button" href="/">Find your {brand.name} home</a>
          </p>
        </header>

        <section>
          <h2>What a Home is</h2>
          <p>
            A {brand.name} Home is a person&apos;s own place in the {brand.community}. It gives you one name that is yours
            everywhere in the network, an agent that acts only as far as you have let it, a private vault that holds
            your records under your own key, and a standing in the organizations, teams and treasuries you belong
            to — so that when you speak, message, give or decide through your Home, the other side can verify it
            was you, and exactly what you allowed.
          </p>
        </section>

        <section>
          <h2>How it holds your authority</h2>
          <ul className="about-list">
            <li><strong>Your identity is an address, not an account.</strong> Your Home is a smart agent on chain; Google, a passkey or a wallet is only how you prove it is yours, and any of them can be replaced without changing who you are.</li>
            <li><strong>Your agent cannot exceed what you signed.</strong> Every act it takes runs under a scoped, time-bound, revocable delegation you granted — verified step by step against the chain, never against a prompt.</li>
            <li><strong>Every act leaves a receipt.</strong> What ran, under whose authority, with which evidence: a record a stranger can recompute, not a log you have to trust.</li>
            <li><strong>Your records stay in your vault.</strong> Messages, memberships, memories and files are encrypted under your key; an organization or an app reads a record only with a grant you can see and revoke.</li>
          </ul>
        </section>

        <section>
          <h2>Who it is for</h2>
          <p>
            People who want one place that is theirs across every community and app they take part in. Organizations
            in the {brand.community} that need members, teams, treasuries and decisions with a verifiable record.
            Developers building apps that ask a person&apos;s own agent instead of holding the person&apos;s keys.
          </p>
        </section>

        <section>
          <h2>For developers</h2>
          <p>
            A {brand.name} Home is a standard target. Your app registers itself, sends the person here to connect, and
            asks her agent as her over the Home MCP or the A2A boundary; a read answers under her standing, an act comes
            back <code>authority_required</code> with the page on her Home where she signs. Start with{' '}
            <a href="/llms.txt">/llms.txt</a> — the coding agent&apos;s entrance — and the{' '}
            <a href={`${SUBSTRATE}/developers`} rel="noopener">developer documentation</a>.
          </p>
        </section>

        <section>
          <h2>Built on Agentic Primitives</h2>
          <p>
            {brand.name} runs on <a href={SUBSTRATE} rel="noopener">Agentic Primitives</a>, an open substrate for agent
            identity, delegated authority, receipts and discovery. Its vocabulary — how people, organizations, agents,
            roles, grants and records relate — is an <a href={`${SUBSTRATE}/ontology`} rel="noopener">open ontology</a>, and
            what an agent knows how to do comes from a <a href="https://skills.faithnet.io" rel="noopener">skills library</a> of
            published, versioned contracts. The ontologies for trust, faith, commerce and coordination are designed at{' '}
            <a href="https://richcanvas3.com" rel="noopener">Rich Canvas</a>.
          </p>
        </section>
      </article>
      <HomeFooter compact />
    </div>
  );
}
