'use client';
// The Content Artifact LIBRARY (spec 335) — a true document-management EXPLORER: a left folder tree
// with drill-in, a breadcrumb + toolbar main pane (list/grid, search, sort), a polished upload modal,
// per-artifact access management (signed entitlements), discussion binding, and move. Multi-source:
// a .ttl may live in GraphDB, a JSON-LD record in a vault — not just blobs. Person + org scoped.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, badgeStyle, modalOverlaySty, shortAddr } from './theme';

type Kind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
type Source = 'blob' | 'graphdb' | 'vault' | 'external';
type Sort = 'name-asc' | 'name-desc' | 'kind' | 'size-desc' | 'newest';
interface Grant { grantee: { address: string; kind: string; label?: string }; actions: string[]; grantedAt: number; revoked?: boolean; entitlementId?: string; resource?: string; signed?: boolean }
interface Artifact { id: string; kind: Kind; name: string; source: Source; folder: string; isFolder?: boolean; pointer?: string; discussionId?: string; contentType: string; size: number; createdAt: number; grants: Grant[] }
interface TreeNode { name: string; path: string; children: TreeNode[] }

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
const fullPath = (a: Artifact) => (a.folder ? `${a.folder}/${a.name}` : a.name);

/** Build the nested folder tree (client-side) from the flat folder paths. */
function buildTree(items: Artifact[]): TreeNode {
  const root: TreeNode = { name: 'Home', path: '', children: [] };
  const map = new Map<string, TreeNode>([['', root]]);
  const ensure = (path: string): TreeNode => {
    const hit = map.get(path); if (hit) return hit;
    const idx = path.lastIndexOf('/');
    const node: TreeNode = { name: idx >= 0 ? path.slice(idx + 1) : path, path, children: [] };
    ensure(idx >= 0 ? path.slice(0, idx) : '').children.push(node);
    map.set(path, node); return node;
  };
  for (const a of items) { if (a.isFolder) ensure(fullPath(a)); else if (a.folder) ensure(a.folder); }
  const sortRec = (n: TreeNode) => { n.children.sort((x, y) => x.name.localeCompare(y.name)); n.children.forEach(sortRec); };
  sortRec(root);
  return root;
}
const flattenPaths = (n: TreeNode, out: string[] = []): string[] => { if (n.path) out.push(n.path); n.children.forEach((c) => flattenPaths(c, out)); return out; };

export function LibrarySection({ orgSa }: { orgSa?: string }) {
  const { session } = useSession();
  const token = session?.token ?? '';
  const scopeQ = orgSa ? `?org=${orgSa}` : '';
  const [items, setItems] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [path, setPath] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name-asc');
  const [openAccessId, setOpenAccessId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const cwd = path.join('/');

  const api = useCallback(async (method: 'GET' | 'POST', payload?: unknown) => {
    const r = await fetch(`/connect/library${scopeQ}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    const b = await r.json().catch(() => ({}));
    if (r.status === 403) { const e = new Error(b.error ?? 'forbidden'); (e as { forbidden?: boolean }).forbidden = true; throw e; }
    if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
    return b;
  }, [token, scopeQ]);

  const load = useCallback(async () => {
    setErr(null);
    try { setItems((await api('GET')).artifacts ?? []); setForbidden(false); }
    catch (e) { if ((e as { forbidden?: boolean }).forbidden) setForbidden(true); else setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { if (token) void load(); }, [token, load]);

  const tree = useMemo(() => buildTree(items), [items]);
  const docCount = useCallback((p: string) => items.filter((a) => !a.isFolder && (p === '' ? true : a.folder === p || a.folder.startsWith(`${p}/`))).length, [items]);

  // main-pane contents for the current folder (or search results)
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const sortItems = useCallback((arr: Artifact[]) => [...arr].sort((a, b) =>
    sort === 'name-desc' ? b.name.localeCompare(a.name) : sort === 'kind' ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    : sort === 'size-desc' ? b.size - a.size : sort === 'newest' ? b.createdAt - a.createdAt : a.name.localeCompare(b.name)), [sort]);
  const folders = useMemo(() => {
    if (searching) return [] as string[];
    const node = flattenNode(tree, cwd);
    return node ? node.children.map((c) => c.name) : [];
  }, [tree, cwd, searching]);
  const files = useMemo(() => sortItems(searching ? items.filter((a) => !a.isFolder && a.name.toLowerCase().includes(q)) : items.filter((a) => !a.isFolder && a.folder === cwd)), [items, cwd, q, searching, sortItems]);

  // actions
  const descend = (name: string) => { setPath([...path, name]); setOpenAccessId(null); };
  const goTo = (segs: string[]) => { setPath(segs); setExpanded((s) => { const n = new Set(s); let acc = ''; for (const seg of segs) { acc = acc ? `${acc}/${seg}` : seg; n.add(acc); } return n; }); };
  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const newFolder = async () => { const name = prompt('Folder name'); if (!name?.trim()) return; try { await api('POST', { action: 'save', org: orgSa, artifact: { name: name.trim(), kind: 'md', source: 'blob', folder: cwd, isFolder: true } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const removeItem = async (a: Artifact) => {
    if (a.isFolder && items.some((x) => x.folder === fullPath(a) || x.folder.startsWith(`${fullPath(a)}/`))) {
      if (!confirm(`Delete "${a.name}" and everything inside it? This can't be undone.`)) return;
    }
    try { await api('POST', { action: 'delete', org: orgSa, id: a.id }); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const move = async (a: Artifact, dest: string) => { if (dest === a.folder) return; try { await api('POST', { action: 'save', org: orgSa, artifact: { ...a, folder: dest } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const grant = async (id: string, addr: string, gk: string, actions: string[], label?: string) => { try { await api('POST', { action: 'grant', org: orgSa, id, grant: { granteeAddress: addr, granteeKind: gk, granteeLabel: label, actions } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const revoke = async (id: string, addr: string) => { try { await api('POST', { action: 'revoke', org: orgSa, id, grant: { granteeAddress: addr } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const discuss = async (id: string) => { try { const r = await api('POST', { action: 'discuss', org: orgSa, id }); await load(); if (orgSa && typeof r.discussionId === 'string' && !r.discussionId.startsWith('disc:')) window.location.href = `/org/${orgSa}/discussions`; } catch (e) { setErr((e as Error).message); } };

  const allFolders = useMemo(() => ['', ...flattenPaths(tree).sort()], [tree]);

  if (forbidden) return (
    <SectionShell title="Organization Library">
      <div style={{ ...cardSty, textAlign: 'center', padding: '2rem' }}>
        <div style={{ fontSize: 28 }}>🔒</div>
        <h3 style={{ margin: '.4rem 0' }}>You&apos;re not a steward of this organization</h3>
        <p style={mutedText}>Only stewards can view or manage this organization&apos;s library.</p>
      </div>
    </SectionShell>
  );

  return (
    <SectionShell title={orgSa ? 'Organization Library' : 'Library'}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        {/* ── left: folder tree ── */}
        <nav style={{ width: 236, flex: 'none', alignSelf: 'stretch', background: 'var(--color-surface-sunken)', border: '1px solid var(--color-border)', borderRadius: 10, padding: '.5rem', overflowY: 'auto', maxHeight: '72vh' }}>
          <TreeRow name="🏠 Home" selected={cwd === ''} count={docCount('')} depth={0} hasChildren={tree.children.length > 0} expanded={expanded.has('__home__')} onToggle={() => toggle('__home__')} onSelect={() => goTo([])} onDrop={(id) => { const a = items.find((x) => x.id === id); if (a) void move(a, ''); }} />
          {tree.children.map((c) => <TreeBranch key={c.path} node={c} depth={1} cwd={cwd} expanded={expanded} count={docCount} onToggle={toggle} onSelect={(p) => goTo(p.split('/'))} onDropItem={(id, dest) => { const a = items.find((x) => x.id === id); if (a) void move(a, dest); }} />)}
        </nav>

        {/* ── right: main pane ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* breadcrumbs + add */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              <button style={crumbSty} onClick={() => goTo([])}>Home</button>
              {path.map((seg, i) => (<span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={mutedText}>/</span>{i === path.length - 1 ? <b>{seg}</b> : <button style={crumbSty} onClick={() => goTo(path.slice(0, i + 1))}>{seg}</button>}</span>))}
            </div>
            <button style={btnPrimarySty} onClick={() => setUploadOpen(true)}>+ Add</button>
          </div>

          {/* toolbar */}
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', margin: '.6rem 0' }}>
            <input style={{ ...inputSty, flex: '1 1 200px' }} placeholder="Search this library…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select style={inputSty} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="kind">Kind</option><option value="size-desc">Size</option><option value="newest">Newest</option>
            </select>
            <div style={{ display: 'inline-flex', border: '1px solid var(--color-border-strong)', borderRadius: 8, overflow: 'hidden' }}>
              <button style={segSty(view === 'list')} onClick={() => setView('list')}>▤ List</button>
              <button style={segSty(view === 'grid')} onClick={() => setView('grid')}>▦ Grid</button>
            </div>
            <button style={btnSty} onClick={() => void newFolder()}>New folder</button>
          </div>

          {err && <p style={errorText}>{err}</p>}

          {/* listing */}
          {loading ? <p style={mutedText}>loading…</p>
            : searching && files.length === 0 ? <p style={mutedText}>No documents match “{query}”.</p>
            : !searching && folders.length === 0 && files.length === 0 ? (
              <div style={{ ...cardSty, textAlign: 'center', padding: '1.6rem' }}>
                <div style={{ fontSize: 26 }}>📂</div>
                <p style={{ ...mutedText, marginTop: 6 }}>{path.length ? 'This folder is empty.' : 'Nothing in your library yet.'}</p>
                <button style={{ ...btnPrimarySty, marginTop: 8 }} onClick={() => setUploadOpen(true)}>+ Add a document</button>
              </div>
            ) : (
              <div style={view === 'grid' && !searching ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '.6rem' } : { display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
                {!searching && folders.map((n) => (
                  view === 'grid'
                    ? <button key={`f:${n}`} style={{ ...cardSty, textAlign: 'center', cursor: 'pointer', padding: '1rem' }} onClick={() => descend(n)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = e.dataTransfer.getData('id'); const a = items.find((x) => x.id === id); if (a) void move(a, cwd ? `${cwd}/${n}` : n); }}><div style={{ fontSize: 26 }}>📁</div><div style={{ marginTop: 4 }}>{n}</div></button>
                    : <div key={`f:${n}`} style={{ ...cardSty, display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer', padding: '.5rem .7rem' }} onClick={() => descend(n)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = e.dataTransfer.getData('id'); const a = items.find((x) => x.id === id); if (a) void move(a, cwd ? `${cwd}/${n}` : n); }}><span style={{ fontSize: 18 }}>📁</span><b>{n}</b><span style={{ ...mutedText, fontSize: 12, marginLeft: 'auto' }}>{docCount(cwd ? `${cwd}/${n}` : n)} items</span></div>
                ))}
                {files.map((a) => (
                  <div key={a.id} draggable onDragStart={(e) => e.dataTransfer.setData('id', a.id)} style={{ ...cardSty, padding: '.5rem .7rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 18 }}>{glyph(a)}</span>
                      <b>{a.name}</b>
                      <span style={{ ...mutedText, fontSize: 12 }}>{a.kind} · {a.source}{a.source === 'blob' ? ` · ${fmtSize(a.size)}` : a.pointer ? ` · ${a.pointer}` : ''}{searching && a.folder ? ` · /${a.folder}` : ''}</span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: '.35rem', alignItems: 'center' }}>
                        {a.discussionId && <span title="has a discussion" style={{ fontSize: 14 }}>💬</span>}
                        <button style={btnSty} onClick={() => setOpenAccessId(openAccessId === a.id ? null : a.id)}>Access ({a.grants.filter((g) => !g.revoked).length})</button>
                        <button style={btnSty} onClick={() => void discuss(a.id)}>Discuss</button>
                        <select style={{ ...inputSty, padding: '.2rem .3rem', fontSize: 12 }} value="" onChange={(e) => { if (e.target.value !== '') void move(a, e.target.value === '__root__' ? '' : e.target.value); }}>
                          <option value="">Move…</option>
                          {allFolders.filter((f) => f !== a.folder).map((f) => <option key={f || '__root__'} value={f === '' ? '__root__' : f}>{f === '' ? 'Home' : `/${f}`}</option>)}
                        </select>
                        <button style={btnSty} onClick={() => void removeItem(a)}>Remove</button>
                      </span>
                    </div>
                    {openAccessId === a.id && <ManageAccess artifact={a} onGrant={grant} onRevoke={revoke} />}
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>

      {uploadOpen && <UploadModal destination={cwd} folders={allFolders} orgSa={orgSa} api={api} onClose={() => setUploadOpen(false)} onDone={() => { setUploadOpen(false); void load(); }} />}
    </SectionShell>
  );
}

// helper: find a tree node by path
function flattenNode(root: TreeNode, path: string): TreeNode | null {
  if (path === '') return root;
  let node: TreeNode | undefined = root;
  for (const seg of path.split('/')) { node = node?.children.find((c) => c.name === seg); if (!node) return null; }
  return node;
}

const crumbSty: CSSProperties = { ...btnSty, padding: '.2rem .5rem' };
const segSty = (on: boolean): CSSProperties => ({ ...btnSty, borderRadius: 0, background: on ? 'var(--color-amber-50)' : 'transparent', color: on ? 'var(--color-amber-700)' : undefined, fontWeight: on ? 700 : undefined });

function TreeRow({ name, selected, count, depth, hasChildren, expanded, onToggle, onSelect, onDrop }: {
  name: string; selected: boolean; count?: number; depth: number; hasChildren: boolean; expanded: boolean; onToggle: () => void; onSelect: () => void; onDrop: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 34, paddingLeft: 4 + depth * 14, borderRadius: 8,
      ...(selected ? { background: 'var(--color-amber-50)', borderLeft: '3px solid var(--color-amber-500)', fontWeight: 700 } : {}),
      ...(over ? { outline: '2px dashed var(--color-amber-500)', background: 'var(--color-amber-50)' } : {}) }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(e.dataTransfer.getData('id')); }}>
      {hasChildren ? <button style={{ ...btnSty, padding: '.1rem .25rem', background: 'none', border: 'none' }} onClick={(e) => { e.stopPropagation(); onToggle(); }}>{expanded ? '▾' : '▸'}</button> : <span style={{ width: 18 }} />}
      <button style={{ ...btnSty, background: 'none', border: 'none', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--color-amber-700)' : 'var(--color-text-body)', fontWeight: selected ? 700 : undefined }} onClick={onSelect}>{name}</button>
      {count ? <span style={{ ...mutedText, fontSize: 11, marginRight: 6 }}>{count}</span> : null}
    </div>
  );
}

function TreeBranch({ node, depth, cwd, expanded, count, onToggle, onSelect, onDropItem }: {
  node: TreeNode; depth: number; cwd: string; expanded: Set<string>; count: (p: string) => number; onToggle: (p: string) => void; onSelect: (p: string) => void; onDropItem: (id: string, dest: string) => void;
}) {
  const open = expanded.has(node.path);
  return (
    <>
      <TreeRow name={`📁 ${node.name}`} selected={cwd === node.path} count={count(node.path)} depth={depth} hasChildren={node.children.length > 0} expanded={open} onToggle={() => onToggle(node.path)} onSelect={() => onSelect(node.path)} onDrop={(id) => onDropItem(id, node.path)} />
      {open && node.children.map((c) => <TreeBranch key={c.path} node={c} depth={depth + 1} cwd={cwd} expanded={expanded} count={count} onToggle={onToggle} onSelect={onSelect} onDropItem={onDropItem} />)}
    </>
  );
}

function ManageAccess({ artifact, onGrant, onRevoke }: { artifact: Artifact; onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void; onRevoke: (id: string, addr: string) => void }) {
  const [addr, setAddr] = useState(''); const [gkind, setGkind] = useState('person'); const [label, setLabel] = useState(''); const [actions, setActions] = useState<string[]>(['read']);
  const toggle = (x: string) => setActions((a) => (a.includes(x) ? a.filter((y) => y !== x) : [...a, x]));
  return (
    <div style={{ marginTop: '.6rem', borderTop: '1px solid var(--color-border)', paddingTop: '.6rem' }}>
      <div style={{ ...mutedText, fontSize: 12 }}>Grants let another agent (person, organization, or service) act on this document. Each grant mints a signed, revocable entitlement — no standing access beyond what&apos;s listed here.</div>
      {artifact.grants.length === 0 && <div style={{ ...mutedText, fontSize: 12, margin: '.4rem 0' }}>No one else has access to this document yet.</div>}
      {artifact.grants.map((g) => (
        <div key={g.grantee.address} style={{ display: 'flex', gap: '.5rem', alignItems: 'center', padding: '.4rem 0', borderBottom: '1px solid var(--color-border)', opacity: g.revoked ? 0.5 : 1 }}>
          <span style={{ fontSize: 12 }}>{g.revoked ? '⚪' : '🟢'}</span>
          <span><b>{g.grantee.label ?? shortAddr(g.grantee.address)}</b> <span style={{ ...mutedText, fontSize: 12 }}>· {g.grantee.kind} · {g.actions.join(', ')}</span></span>
          {!g.revoked && <span style={badgeStyle(g.signed ? 'ok' : 'neutral')}>{g.signed ? 'Signed' : 'Unsigned (demo)'}</span>}
          {g.revoked ? <span style={{ ...mutedText, fontSize: 12, marginLeft: 'auto' }}>revoked</span> : <button style={{ ...btnSty, marginLeft: 'auto' }} onClick={() => onRevoke(artifact.id, g.grantee.address)}>Revoke</button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '.5rem' }}>
        <input style={inputSty} placeholder="grantee SA 0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <select style={inputSty} value={gkind} onChange={(e) => setGkind(e.target.value)}>{['person', 'org', 'service'].map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <input style={inputSty} placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <span style={{ ...mutedText, fontSize: 12 }}>Actions:</span>
        {ACTIONS.map((x) => (<label key={x} style={{ ...mutedText, fontSize: 12, display: 'inline-flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={actions.includes(x)} onChange={() => toggle(x)} />{x}</label>))}
        <button style={btnPrimarySty} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr) || actions.length === 0} onClick={() => onGrant(artifact.id, addr, gkind, actions, label || undefined)}>Grant access</button>
      </div>
    </div>
  );
}

type QRow = { name: string; size: number; status: 'queued' | 'uploading' | 'done' | 'skipped'; file?: File };
function UploadModal({ destination, folders, orgSa, api, onClose, onDone }: {
  destination: string; folders: string[]; orgSa?: string; api: (m: 'GET' | 'POST', p?: unknown) => Promise<any>; onClose: () => void; onDone: () => void;
}) {
  const [tab, setTab] = useState<'upload' | 'ref'>('upload');
  const [dest, setDest] = useState(destination);
  const [drag, setDrag] = useState(false);
  const [queue, setQueue] = useState<QRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // add-by-reference
  const [name, setName] = useState(''); const [kind, setKind] = useState<Kind>('ttl'); const [source, setSource] = useState<Source>('graphdb'); const [pointer, setPointer] = useState(''); const [body, setBody] = useState('');

  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  const enqueue = (fl: FileList | null) => { if (!fl) return; setQueue((q) => [...q, ...Array.from(fl).map((f) => ({ name: f.name, size: f.size, status: f.size > MAX_UPLOAD_BYTES ? 'skipped' as const : 'queued' as const, file: f }))]); };
  const upload = async () => {
    const valid = queue.filter((r) => r.status === 'queued' && r.file);
    if (valid.length === 0) return;
    setBusy(true); setErr(null); setQueue((q) => q.map((r) => (r.status === 'queued' ? { ...r, status: 'uploading' } : r)));
    try {
      const artifacts = await Promise.all(valid.map(async (r) => ({ name: r.name, kind: kindFor(r.file!), source: 'blob', folder: dest === '__root__' ? '' : dest, bytesB64: await fileToBase64(r.file!), contentType: r.file!.type || undefined, size: r.size })));
      await api('POST', { action: 'save-batch', org: orgSa, artifacts });
      setQueue((q) => q.map((r) => (r.status === 'uploading' ? { ...r, status: 'done' } : r)));
      setTimeout(onDone, 400);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const addRef = async () => {
    if (!name.trim()) return;
    try { const artifact: Record<string, unknown> = { name: name.trim(), kind, source, folder: dest === '__root__' ? '' : dest }; if (source === 'blob') artifact.bytesB64 = btoa(body); else artifact.pointer = pointer.trim(); await api('POST', { action: 'save', org: orgSa, artifact }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  const validCount = queue.filter((r) => r.status === 'queued' || r.status === 'uploading').length;

  return (
    <div style={modalOverlaySty} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add to library" style={{ ...cardSty, width: 'min(560px, 92vw)', maxHeight: '85dvh', overflowY: 'auto', padding: '1.25rem' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <h3 style={{ margin: 0, flex: 1 }}>Add to library</h3>
          <select style={{ ...inputSty, fontSize: 12 }} value={dest} onChange={(e) => setDest(e.target.value)} aria-label="destination folder">
            {folders.map((f) => <option key={f || '__root__'} value={f === '' ? '__root__' : f}>{f === '' ? '→ Home' : `→ /${f}`}</option>)}
          </select>
          <button style={{ ...btnSty, background: 'none', border: 'none', fontSize: 18 }} onClick={onClose} aria-label="close">×</button>
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--color-border-strong)', borderRadius: 8, overflow: 'hidden', margin: '.7rem 0' }}>
          <button style={segSty(tab === 'upload')} onClick={() => setTab('upload')}>Upload files</button>
          <button style={segSty(tab === 'ref')} onClick={() => setTab('ref')}>Add by reference</button>
        </div>
        {err && <p style={errorText}>{err}</p>}

        {tab === 'upload' ? (
          <>
            <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); enqueue(e.dataTransfer.files); }}
              style={{ ...cardSty, textAlign: 'center', padding: '1.4rem', border: `2px dashed ${drag ? 'var(--color-amber-500)' : 'var(--color-border-strong)'}`, background: drag ? 'var(--color-amber-50)' : undefined }}>
              <div>Drag files here, or <button style={{ ...btnSty, background: 'none', border: 'none', color: 'var(--color-amber-600)', padding: 0, fontWeight: 600 }} onClick={() => inputRef.current?.click()}>browse files</button></div>
              <div style={{ ...mutedText, fontSize: 12, marginTop: 4 }}>images, SKILL.md, .ttl, .md, JSON-LD — files over 1.4&nbsp;MB are skipped in this demo.</div>
              <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { enqueue(e.target.files); (e.target as HTMLInputElement).value = ''; }} />
            </div>
            <div aria-live="polite" style={{ marginTop: '.6rem', display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
              {queue.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: 13, opacity: r.status === 'skipped' ? 0.6 : 1 }}>
                  <span>{glyph({ kind: kindFor(r.file ?? new File([], r.name)) })}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ ...mutedText, fontSize: 12 }}>{fmtSize(r.size)}</span>
                  <span style={{ fontSize: 12, ...(r.status === 'skipped' ? errorText : r.status === 'done' ? { color: 'var(--color-amber-700)' } : mutedText) }}>{r.status === 'queued' ? '● queued' : r.status === 'uploading' ? '▓ uploading' : r.status === 'done' ? '✓ done' : '⚠ over 1.4 MB'}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.8rem' }}>
              <button style={btnSty} onClick={onClose}>Cancel</button>
              <button style={btnPrimarySty} disabled={busy || validCount === 0} onClick={() => void upload()}>{busy ? 'Uploading…' : `Upload ${validCount} file${validCount === 1 ? '' : 's'}`}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={inputSty} placeholder="name (e.g. faith.ttl)" value={name} onChange={(e) => setName(e.target.value)} />
              <select style={inputSty} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              <select style={inputSty} value={source} onChange={(e) => setSource(e.target.value as Source)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </div>
            {source === 'blob'
              ? <textarea style={{ ...inputSty, width: '100%', minHeight: 70, marginTop: '.5rem' }} placeholder="content" value={body} onChange={(e) => setBody(e.target.value)} />
              : <input style={{ ...inputSty, width: '100%', marginTop: '.5rem' }} placeholder="retrievalPointer (e.g. graphdb:faith/ontology · vault:0x…/record)" value={pointer} onChange={(e) => setPointer(e.target.value)} />}
            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.8rem' }}>
              <button style={btnSty} onClick={onClose}>Cancel</button>
              <button style={btnPrimarySty} onClick={() => void addRef()}>Add to {dest === '__root__' || dest === '' ? 'Home' : `/${dest}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
