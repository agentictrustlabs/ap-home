// A STRUCTURED DOCUMENT, READ AS A PERSON READS IT — spec 412. A JSON-LD record on the shelf (a work's manifest, a
// profile, any `@type`) is rendered as a document, not as a code block: its title, its description, its scalar facts as a
// table, its nested objects as sections, its lists of titled things as lists. Generic over the shape — no vocabulary is
// special-cased here; a renderer that only knew one app's manifest would be that app's page, not the Home's. Hashes and
// long identifiers are shortened with the full value in the title attribute; `@context` and `@type` are shown once, small.
import type { ReactNode } from 'react';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);
const words = (k: string) => k.replace(/^@/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const shortHex = (s: string) => (/^0x[0-9a-fA-F]{20,}$/.test(s) ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);
const isoDate = (s: string) => (/^\d{4}-\d{2}-\d{2}T/.test(s) ? new Date(s).toLocaleString() : null);

/** The document's own title, from the fields a title usually lives in — the caller falls back to the file name. */
export function recordTitle(doc: Json): string | null {
  if (!isObj(doc)) return null;
  for (const path of [['work', 'title'], ['title'], ['name'], ['displayName'], ['headline']]) {
    let v: Json = doc;
    for (const k of path) v = isObj(v) ? (v[k] ?? null) : null;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
export function recordSummary(doc: Json): string | null {
  if (!isObj(doc)) return null;
  for (const path of [['work', 'description'], ['description'], ['summary'], ['about']]) {
    let v: Json = doc;
    for (const k of path) v = isObj(v) ? (v[k] ?? null) : null;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function Scalar({ v }: { v: string | number | boolean | null }) {
  if (v === null || v === '') return <span style={{ opacity: 0.5 }}>—</span>;
  if (typeof v === 'boolean') return <span>{v ? 'yes' : 'no'}</span>;
  if (typeof v === 'number') return <span>{v.toLocaleString()}</span>;
  const d = isoDate(v);
  if (d) return <span title={v}>{d}</span>;
  if (/^https?:\/\//.test(v)) return <a href={v}>{v}</a>;
  const s = shortHex(v);
  return s === v ? <span>{v}</span> : <code title={v} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.85em' }}>{s}</code>;
}

const SKIP = new Set(['@context']);

function Rows({ obj }: { obj: { [k: string]: Json } }) {
  const scalars = Object.entries(obj).filter(([k, v]) => !SKIP.has(k) && !isObj(v) && !Array.isArray(v));
  if (!scalars.length) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.25rem 1rem', margin: '0 0 .8rem' }}>
      {scalars.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ opacity: 0.6, fontSize: '.85rem' }}>{k === '@type' ? 'Type' : words(k)}</dt>
          <dd style={{ margin: 0, fontSize: '.92rem', wordBreak: 'break-word' }}><Scalar v={v as string} /></dd>
        </div>
      ))}
    </dl>
  );
}

function List({ items }: { items: Json[] }) {
  if (items.every((x) => !isObj(x))) return <p style={{ margin: '0 0 .8rem' }}>{items.map((x, i) => <span key={i}>{i ? ' · ' : ''}<Scalar v={x as string} /></span>)}</p>;
  // A list of titled things (parts, chapters, entries): a numbered list of titles, each's other facts small beneath.
  return (
    <ol style={{ margin: '0 0 .8rem', paddingLeft: '1.3rem', display: 'grid', gap: '.35rem' }}>
      {items.map((it, i) => {
        if (!isObj(it)) return <li key={i}><Scalar v={it as string} /></li>;
        const title = recordTitle(it) ?? (typeof it.n === 'number' ? `Part ${it.n}` : `Item ${i + 1}`);
        const rest = Object.entries(it).filter(([k, v]) => !['title', 'name', 'n', 'displayName'].includes(k) && !isObj(v) && !Array.isArray(v) && v !== '' && v !== null);
        return (
          <li key={i}>
            <span style={{ fontWeight: 600 }}>{title}</span>
            {rest.length > 0 && <span style={{ opacity: 0.6, fontSize: '.8rem', marginLeft: '.5rem' }}>{rest.map(([k, v]) => `${words(k).toLowerCase()} ${typeof v === 'string' ? shortHex(v) : String(v)}`).join(' · ')}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Section({ name, value, depth }: { name: string; value: Json; depth: number }): ReactNode {
  const H = depth <= 1 ? 'h2' : 'h3';
  if (Array.isArray(value)) {
    return <section key={name}><H style={{ fontSize: depth <= 1 ? '1.05rem' : '.95rem', margin: '1rem 0 .4rem' }}>{words(name)}{value.length ? <span style={{ opacity: 0.5, fontWeight: 400 }}> · {value.length}</span> : null}</H><List items={value} /></section>;
  }
  if (isObj(value)) {
    const nested = Object.entries(value).filter(([k, v]) => !SKIP.has(k) && (isObj(v) || Array.isArray(v)));
    return (
      <section key={name}>
        <H style={{ fontSize: depth <= 1 ? '1.05rem' : '.95rem', margin: '1rem 0 .4rem' }}>{words(name)}</H>
        <Rows obj={value} />
        {nested.map(([k, v]) => <Section key={k} name={k} value={v} depth={depth + 1} />)}
      </section>
    );
  }
  return null;
}

/** The whole record as a document. The title and summary are rendered by the page (they head it); here is the rest. */
export function RecordDocument({ doc }: { doc: Json }) {
  if (!isObj(doc)) return <pre style={{ whiteSpace: 'pre-wrap', fontSize: '.85rem' }}>{JSON.stringify(doc, null, 2)}</pre>;
  const nested = Object.entries(doc).filter(([k, v]) => !SKIP.has(k) && (isObj(v) || Array.isArray(v)));
  const ctx = doc['@context'];
  return (
    <div className="published-record">
      <Rows obj={doc} />
      {nested.map(([k, v]) => <Section key={k} name={k} value={v} depth={1} />)}
      {ctx !== undefined && <p style={{ opacity: 0.5, fontSize: '.75rem', marginTop: '1rem' }}>Vocabulary: {Array.isArray(ctx) ? ctx.map((c) => (typeof c === 'string' ? c : Object.values(c as { [k: string]: Json }).join(', '))).join(' · ') : String(ctx)}</p>}
    </div>
  );
}
