// SPEC 412 — the shared pieces of a person's PUBLIC pages: which person (the Home's subdomain label, or `?name=` on
// the apex), the page frame, and the sentence that says why a shelf could not be read (never an empty list — 398 §6.3).
import { headers } from 'next/headers';
import { HomeFooter } from '../../src/components/shared/HomeFooter';
import { BrandShield } from '../../src/components/shared/BrandShield';
import { nameLabel, parseAgentSubdomain } from '../../src/lib/domain';

/** The label whose shelf this request is about: the subdomain (carol.faithnet.me → carol), else `?name=`. */
export async function labelFor(searchParams?: { name?: string | string[] }): Promise<string | null> {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(':')[0] ?? '';
  const fromHost = parseAgentSubdomain(host);
  if (fromHost) return fromHost;
  const q = Array.isArray(searchParams?.name) ? searchParams?.name[0] : searchParams?.name;
  const l = q ? nameLabel(q) : '';
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(l) ? l : null;
}

export function ShelfFrame({ label, title, children }: { label: string | null; title: string; children: React.ReactNode }) {
  return (
    <div className="onboarding-screen about-screen">
      <article className="about-page">
        <header className="about-hero">
          <BrandShield size={40} />
          <h1>{title}</h1>
          {label && <p className="about-tagline">Published by <a href="/">{label}</a> · served by their own agent</p>}
        </header>
        {children}
      </article>
      <HomeFooter compact />
    </div>
  );
}

export function Unreadable({ why, cardUri }: { why: string; cardUri?: string }) {
  return (
    <section>
      <p data-testid="shelf-unreadable">The shelf could not be read just now — {why}.</p>
      {cardUri && <p style={{ fontSize: '.85rem', opacity: 0.7 }}>The agent card is at <a href={cardUri}>{cardUri}</a>; the shelf is whatever it answers to <code>library.public.list</code>.</p>}
    </section>
  );
}
