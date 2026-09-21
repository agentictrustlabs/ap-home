// /published — WHAT THIS PERSON MADE PUBLIC, read from her agent the way anyone would (spec 412 §1.5). Server-rendered,
// indexable, no session: the one page of a Home a stranger may read besides the front door and About. Each row is a
// public document on her shelf; a release beside it is the signature she put on it.
import type { Metadata } from 'next';
import { shelfOf } from '../../src/lib/public-shelf';
import { whitelabel } from '../../src/whitelabel/config';
import { labelFor, ShelfFrame, Unreadable } from './_shelf';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ name?: string }> }): Promise<Metadata> {
  const label = await labelFor(await searchParams);
  const title = label ? `Published by ${label}` : `Published — ${whitelabel.brand.name}`;
  return { title: { absolute: title }, description: label ? `What ${label} made public in their ${whitelabel.brand.name} Home — served by their own agent, verifiable by anyone.` : undefined };
}

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

export default async function PublishedPage({ searchParams }: { searchParams: Promise<{ name?: string; folder?: string }> }) {
  const sp = await searchParams;
  const label = await labelFor(sp);
  if (!label) {
    return (
      <ShelfFrame label={null} title="Published">
        <section><p>A shelf belongs to a person. Open it at their Home — <code>&lt;name&gt;.{process.env.NEXT_PUBLIC_CONNECT_DOMAIN ?? 'faithnet.me'}/published</code> — or add <code>?name=&lt;name&gt;</code> here.</p></section>
      </ShelfFrame>
    );
  }
  const r = await shelfOf(label, typeof sp.folder === 'string' ? sp.folder : undefined);
  if (!r.ok) return <ShelfFrame label={label} title={`Published by ${label}`}><Unreadable why={r.why} cardUri={r.cardUri} /></ShelfFrame>;
  const all = r.value.files.filter((f) => !f.isFolder);
  const folders = r.value.files.filter((f) => f.isFolder);
  // A work is its TEXT; its manifest (`<slug>`, json-ld, beside `<slug>.md`) is listed under the text as its proof, not as a
  // second entry. A manifest with no text beside it is listed on its own, and says it is a manifest.
  const textOf = (m: typeof all[number]) => all.find((t) => t.folder === m.folder && t.kind === 'md' && (t.name === `${m.name}.md` || t.name === `${m.name}-preview.md`));
  const tucked = new Set(all.filter((m) => m.kind === 'json-ld' && textOf(m)).map((m) => m.id));
  const manifestOf = (t: typeof all[number]) => all.find((m) => m.kind === 'json-ld' && m.folder === t.folder && (`${m.name}.md` === t.name || `${m.name}-preview.md` === t.name));
  const docs = all.filter((f) => !tucked.has(f.id));
  return (
    <ShelfFrame label={label} title={`Published by ${label}`}>
      <section data-testid="shelf" data-count={docs.length}>
        {docs.length === 0 && <p>{label} has made nothing public yet.</p>}
        {docs.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '.9rem' }}>
            {docs.map((f) => (
              <li key={f.id} style={{ borderBottom: '1px solid var(--color-border, #e7e5e4)', paddingBottom: '.7rem' }}>
                <a href={`/published/${encodeURIComponent(f.id)}${sp.name ? `?name=${encodeURIComponent(label)}` : ''}`} style={{ fontWeight: 600, fontSize: '1.05rem' }}>{f.name.replace(/\.(md|json|jsonld|ttl)$/i, '').replace(/-preview$/, '')}{f.name.endsWith('-preview.md') ? <span style={{ fontWeight: 400, opacity: 0.6 }}> (preview)</span> : null}</a>
                <div style={{ fontSize: '.82rem', opacity: 0.7, marginTop: '.2rem' }}>
                  {f.kind === 'json-ld' ? 'signed manifest — the text is not on this shelf' : f.kind === 'md' ? 'text' : f.kind}{f.version && f.version > 1 ? ` · v${f.version}` : ''}{f.createdAt ? ` · ${fmt(f.createdAt)}` : ''}
                  {f.release ? <> · released {f.release.version}{f.release.signed ? ', signed' : ''}</> : null}
                  {(() => { const m = f.kind === 'md' ? manifestOf(f) : undefined; return m ? <> · <a href={`/published/${encodeURIComponent(m.id)}${sp.name ? `?name=${encodeURIComponent(label)}` : ''}`}>manifest</a></> : null; })()}
                </div>
              </li>
            ))}
          </ul>
        )}
        {folders.length > 0 && <p style={{ fontSize: '.82rem', opacity: 0.7, marginTop: '1rem' }}>Public folders: {folders.map((f) => f.path).join(' · ')}</p>}
      </section>
      <section style={{ fontSize: '.82rem', opacity: 0.75 }}>
        <p>
          This page is what {label}&apos;s agent answers anyone who asks for the public shelf — no account, no key. Agent card: <a href={r.value.cardUri}>{r.value.cardUri}</a>.
          Any A2A client gets the same by sending <code>{'{ "skill": "library.public.list" }'}</code> as a data part to <code>{r.value.endpoint}</code>.
        </p>
      </section>
    </ShelfFrame>
  );
}
