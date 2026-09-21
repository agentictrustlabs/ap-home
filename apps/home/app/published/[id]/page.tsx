// /published/<id> — ONE public document, as the person's agent serves it (spec 412). Markdown is rendered; other text
// is shown as text; an image is shown from its bytes. The release beside it is hers — anyone can check the signature
// against her Smart Agent (ERC-1271) and the commitment against the bytes. A document not on the shelf is answered as
// not on the shelf, whether it is private or does not exist.
import type { Metadata } from 'next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { publicDocumentOf, splitFrontMatter } from '../../../src/lib/public-shelf';
import { whitelabel } from '../../../src/whitelabel/config';
import { labelFor, ShelfFrame, Unreadable } from '../_shelf';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }>; searchParams: Promise<{ name?: string }> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { id } = await params;
  const label = await labelFor(await searchParams);
  if (!label) return { title: { absolute: `Published — ${whitelabel.brand.name}` } };
  const r = await publicDocumentOf(label, id);
  const title = r.ok && r.value ? (splitFrontMatter(r.value.text ?? '').meta.title || r.value.file.name.replace(/\.(md|json|jsonld|ttl)$/i, '')) : 'Not on the shelf';
  return { title: { absolute: `${title} — ${label}` }, ...(r.ok && r.value ? { description: `Published by ${label} at their ${whitelabel.brand.name} Home.` } : {}) };
}

const shortHex = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);

export default async function PublishedDocumentPage({ params, searchParams }: Params) {
  const { id } = await params;
  const sp = await searchParams;
  const label = await labelFor(sp);
  const back = `/published${sp.name ? `?name=${encodeURIComponent(sp.name)}` : ''}`;
  if (!label) return <ShelfFrame label={null} title="Published"><section><p>A document belongs to a person&apos;s shelf — open it at their Home.</p></section></ShelfFrame>;
  const r = await publicDocumentOf(label, id);
  if (!r.ok) return <ShelfFrame label={label} title="Published"><Unreadable why={r.why} cardUri={r.cardUri} /></ShelfFrame>;
  if (!r.value) {
    return (
      <ShelfFrame label={label} title="Not on the shelf">
        <section data-testid="shelf-not-public"><p>{label}&apos;s agent does not serve a public document with that id. <a href={back}>Back to what is published</a>.</p></section>
      </ShelfFrame>
    );
  }
  const { file, text, bytesB64, contentType } = r.value;
  const { meta, body } = splitFrontMatter(text ?? '');
  const title = meta.title || file.name.replace(/\.(md|json|jsonld|ttl)$/i, '');
  const isMarkdown = file.kind === 'md' || /markdown/.test(file.contentType ?? '');
  return (
    <ShelfFrame label={label} title={title}>
      <section data-testid="shelf-document" data-id={file.id}>
        {meta.summary && <p className="about-lede">{meta.summary}</p>}
        {typeof text === 'string' && isMarkdown && <div className="published-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div>}
        {typeof text === 'string' && !isMarkdown && <pre style={{ whiteSpace: 'pre-wrap', fontSize: '.85rem' }}>{text}</pre>}
        {typeof bytesB64 === 'string' && /^image\//.test(contentType ?? '') && <img alt={file.name} src={`data:${contentType};base64,${bytesB64}`} style={{ maxWidth: '100%' }} />}
        {typeof bytesB64 === 'string' && !/^image\//.test(contentType ?? '') && <p>{file.name} — {contentType ?? file.kind}, {file.size ?? '?'} bytes; not rendered here.</p>}
        {r.value.truncated && <p style={{ fontSize: '.82rem', opacity: 0.7 }}>Shown up to the agent&apos;s read bound ({r.value.chars} characters in all).</p>}
      </section>
      <section style={{ fontSize: '.82rem', opacity: 0.8 }} data-testid="shelf-provenance">
        <h2 style={{ fontSize: '1rem' }}>Provenance</h2>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.25rem .8rem', margin: 0 }}>
          <dt>Document</dt><dd style={{ margin: 0 }}>{file.path} · v{file.version ?? 1}{file.createdAt ? ` · ${new Date(file.createdAt).toLocaleDateString()}` : ''}</dd>
          {meta.license && <><dt>License</dt><dd style={{ margin: 0 }}>{meta.license}{meta.attribution ? ` — ${meta.attribution}` : ''}</dd></>}
          {file.commitment && <><dt>Commitment</dt><dd style={{ margin: 0, fontFamily: 'ui-monospace, Menlo, monospace' }} title={file.commitment}>sha256 {shortHex(file.commitment)}</dd></>}
          {file.release
            ? <><dt>Release</dt><dd style={{ margin: 0 }}>{file.release.version} · {file.release.signed ? 'signed by the owner' : 'unsigned'} · {new Date(file.release.publishedAt).toLocaleDateString()} · <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} title={file.release.releaseId}>{shortHex(file.release.releaseId)}</span></dd></>
            : <><dt>Release</dt><dd style={{ margin: 0 }}>none — public, not released</dd></>}
        </dl>
        <p style={{ marginTop: '.8rem' }}><a href={back}>← everything {label} has published</a></p>
      </section>
    </ShelfFrame>
  );
}
