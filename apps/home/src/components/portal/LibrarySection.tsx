'use client';
// The Content Artifact LIBRARY (spec 335) — a document EXPLORER (folders, breadcrumbs, list/grid,
// search) for a person or organization, with drag-and-drop upload and per-artifact access management.
// Artifacts are multi-source: a .ttl may live in GraphDB, a JSON-LD record in a vault — not just blobs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty } from './theme';

type Kind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
type Source = 'blob' | 'graphdb' | 'vault' | 'external';
interface Grant { grantee: { address: string; kind: string; label?: string }; actions: string[]; grantedAt: number; revoked?: boolean }
interface Artifact { id: string; kind: Kind; name: string; source: Source; folder: string; isFolder?: boolean; pointer?: string; contentType: string; size: number; createdAt: number; grants: Grant[] }

const KINDS: Kind[] = ['skill', 'ttl', 'md', 'json-ld', 'image'];
const SOURCES: Source[] = ['blob', 'graphdb', 'vault', 'external'];
const ACTIONS = ['read', 'write', 'share', 'export', 'delete'];
const MAX_UPLOAD_BYTES = 1_400_000;

function kindFor(file: File): Kind {
  const n = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return 'image';
  if (n.endsWith('.ttl')) return 'ttl';
  if (n.endsWith('.jsonld') || n.endsWith('.json')) return 'json-ld';
  if (n === 'skill.md' || n.includes('skill')) return 'skill';
  return 'md';
}
const fileToBase64 = (file: File): Promise<string> =>
  new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)); }; r.onerror = () => rej(r.error); r.readAsDataURL(file); });
const glyph = (a: { isFolder?: boolean; kind?: Kind }) =>
  a.isFolder ? '📁' : a.kind === 'image' ? '🖼️' : a.kind === 'ttl' ? '🕸️' : a.kind === 'skill' ? '🧩' : a.kind === 'json-ld' ? '⟦⟧' : '📄';
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export function LibrarySection({ orgSa }: { orgSa?: string }) {
  const { session } = useSession();
  const token = session?.token ?? '';
  const scope = orgSa ? `?org=${orgSa}` : '';
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // explorer state
  const [path, setPath] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const cwd = path.join('/');

  // upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  // add-by-reference (GraphDB / vault / typed content)
  const [showRef, setShowRef] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('md');
  const [source, setSource] = useState<Source>('graphdb');
  const [pointer, setPointer] = useState('');
  const [body, setBody] = useState('');

  const api = useCallback(async (method: 'GET' | 'POST', payload?: unknown) => {
    const r = await fetch(`/connect/library${scope}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
    return b;
  }, [token, scope]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setItems((await api('GET')).artifacts ?? []); } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [api]);
  useEffect(() => { if (token) void load(); }, [token, load]);

  // ── derived explorer view ──
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const results = useMemo(() => (searching ? items.filter((a) => !a.isFolder && a.name.toLowerCase().includes(q)) : []), [items, q, searching]);
  const folderMarker = useMemo(() => new Map(items.filter((a) => a.isFolder).map((a) => [(a.folder ? `${a.folder}/${a.name}` : a.name), a])), [items]);
  const folders = useMemo(() => {
    if (searching) return [] as string[];
    const names = new Set<string>();
    for (const a of items) {
      if (a.isFolder && a.folder === cwd) names.add(a.name);
      const inScope = cwd === '' ? a.folder !== '' : a.folder === cwd || a.folder.startsWith(`${cwd}/`);
      if (a.folder !== cwd && inScope) { const rest = cwd === '' ? a.folder : a.folder.slice(cwd.length + 1); const seg = rest.split('/')[0]; if (seg) names.add(seg); }
    }
    return [...names].sort();
  }, [items, cwd, searching]);
  const files = useMemo(() => (searching ? [] : items.filter((a) => !a.isFolder && a.folder === cwd)), [items, cwd, searching]);

  // ── actions ──
  const handleFiles = async (fl: FileList | null) => {
    if (!fl || fl.length === 0) return;
    setUploading(true); setUploadMsg(null); setErr(null);
    const artifacts: Record<string, unknown>[] = []; const skipped: string[] = [];
    for (const f of Array.from(fl)) {
      if (f.size > MAX_UPLOAD_BYTES) { skipped.push(f.name); continue; }
      try { artifacts.push({ name: f.name, kind: kindFor(f), source: 'blob', folder: cwd, bytesB64: await fileToBase64(f), contentType: f.type || undefined, size: f.size }); } catch { skipped.push(f.name); }
    }
    try { if (artifacts.length) await api('POST', { action: 'save-batch', org: orgSa, artifacts }); setUploadMsg(`Uploaded ${artifacts.length}${skipped.length ? ` · skipped ${skipped.length} over 1.4 MB (${skipped.join(', ')})` : ''}`); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setUploading(false); }
  };
  const addRef = async () => {
    if (!name.trim()) return;
    try {
      const artifact: Record<string, unknown> = { name: name.trim(), kind, source, folder: cwd };
      if (source === 'blob') artifact.bytesB64 = btoa(body); else artifact.pointer = pointer.trim();
      await api('POST', { action: 'save', org: orgSa, artifact }); setName(''); setBody(''); setPointer(''); setShowRef(false); await load();
    } catch (e) { setErr((e as Error).message); }
  };
  const newFolder = async () => {
    const n = prompt('Folder name'); if (!n?.trim()) return;
    try { await api('POST', { action: 'save', org: orgSa, artifact: { name: n.trim(), kind: 'md', source: 'blob', folder: cwd, isFolder: true } }); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const remove = async (id: string) => { try { await api('POST', { action: 'delete', org: orgSa, id }); await load(); } catch (e) { setErr((e as Error).message); } };
  const grant = async (id: string, addr: string, gkind: string, actions: string[], label?: string) => { try { await api('POST', { action: 'grant', org: orgSa, id, grant: { granteeAddress: addr, granteeKind: gkind, granteeLabel: label, actions } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const revoke = async (id: string, addr: string) => { try { await api('POST', { action: 'revoke', org: orgSa, id, grant: { granteeAddress: addr } }); await load(); } catch (e) { setErr((e as Error).message); } };

  const crumb = (i: number) => setPath(path.slice(0, i));
  const descend = (folderName: string) => { setPath([...path, folderName]); setOpenId(null); };

  const FolderTile = ({ n }: { n: string }) => {
    const marker = folderMarker.get(cwd ? `${cwd}/${n}` : n);
    return view === 'grid'
      ? <button style={{ ...cardSty, textAlign: 'center', cursor: 'pointer', padding: '1rem' }} onClick={() => descend(n)}><div style={{ fontSize: 28 }}>📁</div><div style={{ marginTop: 4 }}>{n}</div></button>
      : <div style={{ ...cardSty, display: 'flex', alignItems: 'center', gap: '.6rem', cursor: 'pointer', padding: '.5rem .7rem' }} onClick={() => descend(n)}>
          <span style={{ fontSize: 18 }}>📁</span><b>{n}</b>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }} onClick={(e) => e.stopPropagation()}>
            {marker && <button style={btnSty} onClick={() => void remove(marker.id)}>Delete</button>}
          </span>
        </div>;
  };

  const FileRow = ({ a }: { a: Artifact }) => (
    <div style={{ ...cardSty, padding: '.5rem .7rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18 }}>{glyph(a)}</span>
        <b>{a.name}</b>
        <span style={{ ...mutedText, fontSize: 12 }}>{a.kind} · {a.source}{a.source === 'blob' ? ` · ${fmtSize(a.size)}` : a.pointer ? ` · ${a.pointer}` : ''}{searching && a.folder ? ` · /${a.folder}` : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem' }}>
          <button style={btnSty} onClick={() => setOpenId(openId === a.id ? null : a.id)}>Access ({a.grants.filter((g) => !g.revoked).length})</button>
          <button style={btnSty} onClick={() => void remove(a.id)}>Remove</button>
        </span>
      </div>
      {openId === a.id && <ManageAccess artifact={a} onGrant={grant} onRevoke={revoke} />}
    </div>
  );

  return (
    <SectionShell title={orgSa ? 'Organization Library' : 'Library'}>
      <p style={mutedText}>
        A document explorer for Content Artifacts — SKILL.md, ontology <code style={mono}>.ttl</code>, docs, JSON-LD, images.
        Organize in folders, upload by drag-and-drop, and grant other agents (person / organization / service) access to any item.
      </p>

      {/* toolbar: breadcrumbs · search · view · new folder */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', marginTop: '.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <button style={{ ...btnSty, padding: '.2rem .5rem' }} onClick={() => crumb(0)}>Home</button>
          {path.map((seg, i) => (<span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={mutedText}>/</span><button style={{ ...btnSty, padding: '.2rem .5rem' }} onClick={() => crumb(i + 1)}>{seg}</button></span>))}
        </div>
        <input style={{ ...inputSty, marginLeft: 'auto', minWidth: 180 }} placeholder="Search all documents…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div style={{ display: 'inline-flex', border: '1px solid #39414f', borderRadius: 8, overflow: 'hidden' }}>
          <button style={{ ...btnSty, borderRadius: 0, background: view === 'list' ? '#2a2f3a' : undefined }} onClick={() => setView('list')}>List</button>
          <button style={{ ...btnSty, borderRadius: 0, background: view === 'grid' ? '#2a2f3a' : undefined }} onClick={() => setView('grid')}>Grid</button>
        </div>
        <button style={btnSty} onClick={() => void newFolder()}>New folder</button>
      </div>

      {err && <p style={errorText}>{err}</p>}

      {/* drag-and-drop upload (into the current folder) */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        style={{ ...cardSty, marginTop: '.6rem', padding: '1.1rem', textAlign: 'center', cursor: 'pointer', border: `2px dashed ${dragOver ? '#6ea8fe' : '#39414f'}`, background: dragOver ? 'rgba(110,168,254,0.10)' : undefined }}
      >
        <div style={{ fontWeight: 600 }}>{uploading ? 'Uploading…' : `Drag & drop files into ${cwd ? `/${cwd}` : 'this library'}`}</div>
        <div style={{ ...mutedText, fontSize: 12, marginTop: 4 }}>images, SKILL.md, <code style={mono}>.ttl</code>, <code style={mono}>.md</code>, JSON-LD — or click to browse. Files over 1.4&nbsp;MB are skipped in this demo.</div>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void handleFiles(e.target.files); (e.target as HTMLInputElement).value = ''; }} />
        {uploadMsg && <div style={{ ...mutedText, fontSize: 12, marginTop: 8 }}>{uploadMsg}</div>}
      </div>

      <div style={{ marginTop: '.4rem' }}>
        <button style={{ ...btnSty, fontSize: 12 }} onClick={() => setShowRef((s) => !s)}>{showRef ? '− ' : '+ '}Add by reference (GraphDB / vault / typed content)</button>
        {showRef && (
          <div style={{ ...cardSty, marginTop: '.4rem' }}>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={inputSty} placeholder="name (e.g. faith.ttl)" value={name} onChange={(e) => setName(e.target.value)} />
              <select style={inputSty} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              <select style={inputSty} value={source} onChange={(e) => setSource(e.target.value as Source)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </div>
            {source === 'blob'
              ? <textarea style={{ ...inputSty, width: '100%', minHeight: 70, marginTop: '.5rem' }} placeholder="content" value={body} onChange={(e) => setBody(e.target.value)} />
              : <input style={{ ...inputSty, width: '100%', marginTop: '.5rem' }} placeholder="retrievalPointer (e.g. graphdb:faith/ontology · vault:0x…/record)" value={pointer} onChange={(e) => setPointer(e.target.value)} />}
            <div style={{ marginTop: '.5rem' }}><button style={btnPrimarySty} onClick={() => void addRef()}>Add to {cwd ? `/${cwd}` : 'library'}</button></div>
          </div>
        )}
      </div>

      {/* listing */}
      <div style={{ marginTop: '.8rem', ...(view === 'grid' && !searching ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '.6rem' } : { display: 'flex', flexDirection: 'column', gap: '.4rem' }) }}>
        {loading && <p style={mutedText}>loading…</p>}
        {!loading && searching && results.length === 0 && <p style={mutedText}>No documents match “{query}”.</p>}
        {!loading && !searching && folders.length === 0 && files.length === 0 && <p style={mutedText}>This folder is empty. Drop files here or create a folder.</p>}
        {!searching && folders.map((n) => <FolderTile key={`f:${n}`} n={n} />)}
        {(searching ? results : files).map((a) => <FileRow key={a.id} a={a} />)}
      </div>
    </SectionShell>
  );
}

function ManageAccess({ artifact, onGrant, onRevoke }: {
  artifact: Artifact;
  onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void;
  onRevoke: (id: string, addr: string) => void;
}) {
  const [addr, setAddr] = useState('');
  const [gkind, setGkind] = useState('person');
  const [label, setLabel] = useState('');
  const [actions, setActions] = useState<string[]>(['read']);
  const toggle = (x: string) => setActions((a) => (a.includes(x) ? a.filter((y) => y !== x) : [...a, x]));
  return (
    <div style={{ marginTop: '.6rem', borderTop: '1px solid #2a2f3a', paddingTop: '.6rem' }}>
      <div style={{ ...mutedText, fontSize: 12 }}>Give another agent (person / organization / service) access to this artifact. A grant becomes a revocable entitlement + delegation (ADR-0019).</div>
      {artifact.grants.map((g) => (
        <div key={g.grantee.address} style={{ display: 'flex', gap: '.5rem', alignItems: 'center', margin: '.3rem 0', opacity: g.revoked ? 0.5 : 1 }}>
          <code style={mono}>{g.grantee.label ? `${g.grantee.label} · ` : ''}{g.grantee.address.slice(0, 10)}…</code>
          <span style={{ ...mutedText, fontSize: 12 }}>{g.grantee.kind} · {g.actions.join(', ')}{g.revoked ? ' · revoked' : ''}</span>
          {!g.revoked && <button style={btnSty} onClick={() => onRevoke(artifact.id, g.grantee.address)}>Revoke</button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '.4rem' }}>
        <input style={inputSty} placeholder="grantee SA 0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <select style={inputSty} value={gkind} onChange={(e) => setGkind(e.target.value)}>{['person', 'org', 'service'].map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <input style={inputSty} placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        {ACTIONS.map((x) => (<label key={x} style={{ ...mutedText, fontSize: 12, display: 'inline-flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={actions.includes(x)} onChange={() => toggle(x)} />{x}</label>))}
        <button style={btnPrimarySty} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr) || actions.length === 0} onClick={() => onGrant(artifact.id, addr, gkind, actions, label || undefined)}>Grant access</button>
      </div>
    </div>
  );
}
