'use client';
// The Content Artifact library (spec 335) as a FEDERATED, VAULT-FIRST explorer. Content lives in
// Person / Organization / Service Smart-Agent vaults reached via A2A + MCP; this is a lens across them.
// The model answers, in order: whose vault is this authoritative in · what's my relationship to it ·
// how fresh is what I see · what may I do. A left SCOPE rail (lenses, not a folder tree), a calm
// provenance-first LIST (no per-row button clutter), and an on-demand DETAIL panel (Content · Access ·
// Provenance · Versions) with one ownership-aware primary action + an overflow. See docs/architecture/
// agentic-content-fabric.md and the explorer UX spec. Multi-source: a .ttl may live in GraphDB, a
// JSON-LD record in a vault — not just blobs.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSession } from '../../context/session';
import { SectionShell } from './SectionShell';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, badgeStyle, modalOverlaySty, infoBannerSty, shortAddr, type BadgeKind } from './theme';

type Kind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
type Source = 'blob' | 'graphdb' | 'vault' | 'external';
type Sort = 'name' | 'kind' | 'newest' | 'freshness';
type AccessMode = 'Owned' | 'Read-through' | 'Replica' | 'Public' | 'Projection';
type Freshness = 'Live' | 'Signed' | 'Cached' | 'Stale' | 'Unavailable';
type Lens = 'vault' | 'shared' | 'public';
interface Grant { grantee: { address: string; kind: string; label?: string }; actions: string[]; grantedAt: number; revoked?: boolean; entitlementId?: string; resource?: string; signed?: boolean; inheritedFrom?: string; delegation?: { caveats?: unknown[] } }
interface Release { canonicalId: string; version: string; bundleRoot: string; owner: string; publisher: string; riskTier: string; releaseId: string; signed: boolean; publishedAt: number }
interface Artifact { id: string; kind: Kind; name: string; source: Source; folder: string; isFolder?: boolean; pointer?: string; discussionId?: string; contentType: string; bytesB64?: string; size: number; createdAt: number; version?: number; contentCommitment?: string; grants: Grant[]; effectiveGrants?: Grant[]; releases?: Release[];
  // present on "Shared with me" rows (a federated inbound grant from another vault)
  accessMode?: AccessMode; sharedBy?: string; sharedByKind?: string; myActions?: string[] }
interface TreeNode { name: string; path: string; children: TreeNode[] }

const KINDS: Kind[] = ['skill', 'ttl', 'md', 'json-ld', 'image'];
const SOURCES: Source[] = ['blob', 'graphdb', 'vault', 'external'];
const ACTIONS = ['read', 'write', 'share', 'export', 'delete'];
const MAX_UPLOAD_BYTES = 1_400_000;

// Kind → the WORD the UI shows + its icon. Words carry meaning; icons aid scanning (paired, never alone).
const KIND_META: Record<Kind, { label: string; plural: string; icon: IconName }> = {
  skill: { label: 'Skill', plural: 'Skills', icon: 'skill' },
  ttl: { label: 'Ontology', plural: 'Ontologies', icon: 'ontology' },
  'json-ld': { label: 'Record', plural: 'Records', icon: 'record' },
  image: { label: 'Image', plural: 'Images', icon: 'image' },
  md: { label: 'Document', plural: 'Documents', icon: 'document' },
};
const ACCESS_TONE: Record<AccessMode, BadgeKind> = { Owned: 'ok', Public: 'ok', 'Read-through': 'neutral', Replica: 'neutral', Projection: 'warn' };
const FRESH_TONE: Record<Freshness, BadgeKind> = { Live: 'ok', Signed: 'ok', Cached: 'neutral', Stale: 'warn', Unavailable: 'err' };

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
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
const fullPath = (a: Pick<Artifact, 'folder' | 'name'>) => (a.folder ? `${a.folder}/${a.name}` : a.name);
// Phase-1a derivations. In your own vault everything is Owned; freshness follows the source until the
// backend surfaces real signed/cached state (Phase 1b). A container has no single content version.
const freshnessOf = (a: Artifact): Freshness => (a.isFolder ? 'Live' : a.source === 'blob' ? 'Signed' : a.source === 'external' ? 'Cached' : 'Live');
const authorityText = (mode: AccessMode) => (mode === 'Owned' ? 'Read · write · share' : mode === 'Projection' ? 'Request access' : 'Read only');

/** Build the nested folder tree (client-side) from flat folder paths — used for the destination picker
 *  and the "add here" breadcrumb, not as primary navigation. */
function buildTree(items: Artifact[]): TreeNode {
  const root: TreeNode = { name: 'All items', path: '', children: [] };
  const map = new Map<string, TreeNode>([['', root]]);
  const ensure = (path: string): TreeNode => {
    const hit = map.get(path); if (hit) return hit;
    const idx = path.lastIndexOf('/');
    const node: TreeNode = { name: idx >= 0 ? path.slice(idx + 1) : path, path, children: [] };
    ensure(idx >= 0 ? path.slice(0, idx) : '').children.push(node);
    map.set(path, node); return node;
  };
  for (const a of items) { if (a.isFolder) ensure(fullPath(a)); else if (a.folder) ensure(a.folder); }
  return root;
}
const flattenPaths = (n: TreeNode, out: string[] = []): string[] => { if (n.path) out.push(n.path); n.children.forEach((c) => flattenPaths(c, out)); return out; };

// ── icon system — monochrome line icons, currentColor, paired with words ──
type IconName = 'skill' | 'ontology' | 'document' | 'record' | 'image' | 'folder' | 'vault' | 'org'
  | 'shared' | 'public' | 'chevron' | 'plus' | 'search' | 'more' | 'close' | 'check' | 'lock';
const ICONS: Record<IconName, ReactNode> = {
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-9 9" /></>,
  skill: <path d="M12 3l1.9 4.8L19 9l-4.1 1.5L12 15l-1.9-4.5L6 9l5.1-1.2z" />,
  ontology: <><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="7" r="2.3" /><circle cx="12" cy="18" r="2.3" /><path d="M8.1 6.6l7.8.6M7.4 7.9l3.6 8M15.9 9l-3.4 7" /></>,
  record: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
  vault: <path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6z" />,
  org: <><path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16" /><path d="M14 21V10h4a1 1 0 0 1 1 1v10" /><path d="M7.5 8h3M7.5 12h3M7.5 16h3" /></>,
  shared: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 5.2a3 3 0 0 1 0 5.6M21 20c0-2.4-1.4-4.5-3.5-5.4" /></>,
  public: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.4 2.5 3.7 5.7 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.7-3.7-9S9.6 5.5 12 3z" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  more: <><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M20 6L9 17l-5-5" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
};
function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, ...style }}>
      {ICONS[name]}
    </svg>
  );
}

export function LibrarySection({ orgSa }: { orgSa?: string }) {
  const { session } = useSession();
  const token = session?.token ?? '';
  const scopeQ = orgSa ? `?org=${orgSa}` : '';
  const [items, setItems] = useState<Artifact[]>([]);
  const [sharedItems, setSharedItems] = useState<Artifact[]>([]);
  const [requests, setRequests] = useState<{ requester: string; artifactId: string; artifactName?: string; actions: string[]; at: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [lens, setLens] = useState<Lens>('vault');
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [kindFilter, setKindFilter] = useState<Kind | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const cwd = path.join('/');

  const ownerLabel = orgSa ? 'This organization' : 'You';
  const ownerVaultKind = orgSa ? 'Organization vault' : 'Person vault';

  const api = useCallback(async (method: 'GET' | 'POST', payload?: unknown) => {
    const r = await fetch(`/connect/library${scopeQ}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    const b = await r.json().catch(() => ({}));
    if (r.status === 403) { const e = new Error(b.error ?? 'forbidden'); (e as { forbidden?: boolean }).forbidden = true; throw e; }
    if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
    return b;
  }, [token, scopeQ]);

  const load = useCallback(async () => {
    setErr(null);
    try { const b = await api('GET'); setItems(b.artifacts ?? []); setRequests(b.requests ?? []); setForbidden(false); }
    catch (e) { if ((e as { forbidden?: boolean }).forbidden) setForbidden(true); else setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { if (token) void load(); }, [token, load]);

  // "Shared with me" — the federated inbound lens, fetched separately from the owned vault list.
  const loadShared = useCallback(async () => {
    setSharedLoading(true);
    try {
      const sep = scopeQ ? '&' : '?';
      const r = await fetch(`/connect/library${scopeQ}${sep}lens=shared`, { headers: { authorization: `Bearer ${token}` } });
      const b = await r.json().catch(() => ({}));
      setSharedItems(Array.isArray(b.artifacts) ? b.artifacts : []);
    } catch { /* non-fatal */ } finally { setSharedLoading(false); }
  }, [scopeQ, token]);
  useEffect(() => { if (token && lens === 'shared') void loadShared(); }, [token, lens, loadShared]);

  const tree = useMemo(() => buildTree(items), [items]);
  const allFolders = useMemo(() => ['', ...flattenPaths(tree).sort()], [tree]);
  const selected = useMemo(() => [...items, ...sharedItems].find((x) => x.id === selectedId) ?? null, [items, sharedItems, selectedId]);

  // The current lens's rows. `vault` = your own vault at the current folder (or a search across it);
  // `shared` = the federated inbound-grant lens; `public` = the network registry (Phase 5).
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const rows = useMemo(() => {
    if (lens === 'public') return [] as Artifact[];
    const source = lens === 'shared' ? sharedItems : items;
    let arr = lens === 'shared'
      ? (searching ? source.filter((a) => a.name.toLowerCase().includes(q)) : source)
      : source.filter((a) => (searching ? a.name.toLowerCase().includes(q) : a.folder === cwd));
    if (kindFilter !== 'all') arr = arr.filter((a) => !a.isFolder && a.kind === kindFilter);
    return [...arr].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1; // folders first
      return sort === 'kind' ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : sort === 'newest' ? b.createdAt - a.createdAt
        : sort === 'freshness' ? freshnessOf(a).localeCompare(freshnessOf(b))
        : a.name.localeCompare(b.name);
    });
  }, [items, sharedItems, lens, cwd, q, searching, sort, kindFilter]);

  // actions
  const select = (id: string | null) => setSelectedId(id);
  const descend = (folderName: string) => { setPath([...path, folderName]); setSelectedId(null); };
  const goTo = (segs: string[]) => { setPath(segs); setSelectedId(null); };
  const newFolder = async () => { const name = prompt('Folder name'); if (!name?.trim()) return; try { await api('POST', { action: 'save', org: orgSa, artifact: { name: name.trim(), kind: 'md', source: 'blob', folder: cwd, isFolder: true } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const removeItem = async (a: Artifact) => {
    if (a.isFolder && items.some((x) => x.folder === fullPath(a) || x.folder.startsWith(`${fullPath(a)}/`)) && !confirm(`Delete "${a.name}" and everything inside it? This can't be undone.`)) return;
    try { await api('POST', { action: 'delete', org: orgSa, id: a.id }); setSelectedId(null); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const move = async (a: Artifact, dest: string) => { if (dest === a.folder) return; try { await api('POST', { action: 'save', org: orgSa, artifact: { ...a, folder: dest } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const grant = async (id: string, addr: string, gk: string, actions: string[], label?: string) => { try { await api('POST', { action: 'grant', org: orgSa, id, grant: { granteeAddress: addr, granteeKind: gk, granteeLabel: label, actions } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const revoke = async (id: string, addr: string) => { try { await api('POST', { action: 'revoke', org: orgSa, id, grant: { granteeAddress: addr } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const discuss = async (id: string) => { try { const r = await api('POST', { action: 'discuss', org: orgSa, id }); await load(); if (orgSa && typeof r.discussionId === 'string' && !r.discussionId.startsWith('disc:')) window.location.href = `/org/${orgSa}/discussions`; } catch (e) { setErr((e as Error).message); } };
  // Phase 3 — the cross-vault read path. `openLive` presents the reader's authority to the OWNER's
  // vault, which re-checks the grant and releases an audience-bound copy. `requestAccess` asks an owner.
  const openLive = useCallback(async (a: Artifact): Promise<Artifact> => {
    const r = await api('POST', { action: 'open', ownerScope: a.sharedBy, ownerKind: a.sharedByKind ?? 'person', id: a.id });
    return r.artifact as Artifact;
  }, [api]);
  const requestAccess = useCallback(async (a: Artifact, actions: string[]) => { await api('POST', { action: 'request-access', ownerScope: a.sharedBy, id: a.id, actions, artifactName: a.name }); }, [api]);
  const publish = async (id: string) => { try { await api('POST', { action: 'publish', org: orgSa, id }); await load(); } catch (e) { setErr((e as Error).message); } };
  const approveRequest = async (r: { requester: string; artifactId: string; actions: string[] }) => { await grant(r.artifactId, r.requester, 'person', r.actions.length ? r.actions : ['read']); };

  const writable = lens === 'vault';
  const title = orgSa ? 'Organization Library' : 'Library';

  if (forbidden) return (
    <SectionShell title="Organization Library">
      <div style={{ ...cardSty, textAlign: 'center', padding: '2rem' }}>
        <div style={{ display: 'inline-flex', color: 'var(--color-text-muted)' }}><Icon name="lock" size={28} /></div>
        <h3 style={{ margin: '.4rem 0' }}>You&apos;re not a steward of this organization</h3>
        <p style={mutedText}>Only stewards can view or manage this organization&apos;s library.</p>
      </div>
    </SectionShell>
  );

  return (
    <SectionShell title={title}>
      {/* Explicit text color so every descendant inherits a defined token — never a white ambient
          (e.g. a browser/OS dark-mode default) on our light surfaces. */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', color: 'var(--color-text-body)' }}>
        <ScopeRail lens={lens} onLens={(l) => { setLens(l); setSelectedId(null); setPath([]); }} orgLabel={orgSa ? shortAddr(orgSa) : undefined} ownerLabel={ownerLabel} sharedCount={0} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', marginBottom: '.5rem' }}>
            <Breadcrumb lens={lens} path={path} onGo={goTo} />
            <div style={{ flex: 1 }} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...inputSty, padding: '.35rem .5rem' }}>
              <Icon name="search" size={14} style={{ color: 'var(--color-text-muted)' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${lens === 'vault' ? 'this vault' : lens === 'shared' ? 'shared items' : 'public releases'}…`} style={{ border: 'none', outline: 'none', background: 'transparent', color: 'inherit', width: 160 }} />
            </label>
            {writable && <button style={{ ...btnPrimarySty, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setUploadOpen(true)}><Icon name="plus" size={14} />Add to vault</button>}
          </div>

          {/* filters */}
          {lens !== 'public' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.5rem' }}>
              <div style={{ display: 'inline-flex', border: '1px solid var(--color-border-strong)', borderRadius: 8, overflow: 'hidden' }}>
                {(['all', ...KINDS] as const).map((k) => (
                  <button key={k} style={segSty(kindFilter === k)} onClick={() => setKindFilter(k)}>{k === 'all' ? 'All' : KIND_META[k].plural}</button>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              <span style={{ ...mutedText, fontSize: 12 }}>Sort</span>
              <select style={{ ...inputSty, fontSize: 12, padding: '.3rem .4rem' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {(['name', 'kind', 'newest', 'freshness'] as Sort[]).map((s) => <option key={s} value={s}>{s === 'name' ? 'Name' : s === 'kind' ? 'Kind' : s === 'newest' ? 'Newest' : 'Freshness'}</option>)}
              </select>
              {writable && <button style={btnSty} onClick={() => void newFolder()}>New folder</button>}
            </div>
          )}

          {err && <p style={errorText}>{err}</p>}

          {lens === 'vault' && requests.length > 0 && <RequestsBanner requests={requests} onApprove={approveRequest} />}

          {/* list + detail */}
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {lens === 'public'
                ? <FederatedPlaceholder lens="public" />
                : (lens === 'vault' && loading) || (lens === 'shared' && sharedLoading) ? <p style={mutedText}>loading…</p>
                : rows.length === 0 ? (
                  <div style={{ ...cardSty, textAlign: 'center', padding: '1.6rem' }}>
                    <p style={mutedText}>{
                      lens === 'shared' ? (searching ? `No shared items match “${query}”.` : 'Nothing has been shared with you yet.')
                        : searching ? `No matches for “${query}” in this vault.` : path.length ? 'This folder is empty.' : 'Nothing in your vault yet.'
                    }</p>
                    {writable && !searching && <button style={{ ...btnPrimarySty, marginTop: 8 }} onClick={() => setUploadOpen(true)}>Add to vault</button>}
                  </div>
                ) : (
                  <ArtifactList rows={rows} selectedId={selectedId} ownerLabel={ownerLabel} onOpen={select} onDescend={descend} />
                )}
            </div>

            {selected && (
              <DetailPanel
                key={selected.id}
                artifact={selected}
                items={items}
                ownerLabel={ownerLabel}
                ownerVaultKind={ownerVaultKind}
                folders={allFolders}
                onClose={() => setSelectedId(null)}
                onGrant={grant}
                onRevoke={revoke}
                onDiscuss={discuss}
                onMove={move}
                onRemove={removeItem}
                onOpenMember={select}
                onOpenLive={openLive}
                onRequestAccess={requestAccess}
                onPublish={publish}
              />
            )}
          </div>
        </div>
      </div>

      {uploadOpen && <UploadModal destination={cwd} folders={allFolders} orgSa={orgSa} api={api} onClose={() => setUploadOpen(false)} onDone={() => { setUploadOpen(false); void load(); }} />}
    </SectionShell>
  );
}

// ── scope rail — lenses, not folders ──
function ScopeRail({ lens, onLens, orgLabel, ownerLabel, sharedCount }: { lens: Lens; onLens: (l: Lens) => void; orgLabel?: string; ownerLabel: string; sharedCount: number }) {
  const item = (key: Lens, icon: IconName, label: string, sub: string) => {
    const on = lens === key;
    return (
      <button key={key} role="option" aria-selected={on} onClick={() => onLens(key)}
        style={{ display: 'flex', gap: '.55rem', alignItems: 'flex-start', width: '100%', textAlign: 'left', padding: '.5rem .6rem', border: 'none', cursor: 'pointer',
          borderLeft: `3px solid ${on ? 'var(--color-amber-500)' : 'transparent'}`, background: on ? 'var(--color-amber-50)' : 'transparent', color: on ? 'var(--color-amber-700)' : 'var(--color-text-body)' }}>
        <Icon name={icon} size={17} style={{ marginTop: 1 }} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: on ? 700 : 600, fontSize: 13 }}>{label}</span>
          <span style={{ display: 'block', ...mutedText, fontSize: 11 }}>{sub}</span>
        </span>
      </button>
    );
  };
  return (
    <div role="listbox" aria-label="Scope" style={{ ...cardSty, padding: '.4rem 0', width: 200, flexShrink: 0 }}>
      <div style={{ ...mutedText, fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', padding: '.3rem .7rem' }}>Scope</div>
      {orgLabel
        ? item('vault', 'org', ownerLabel === 'This organization' ? 'This organization' : orgLabel, 'Organization vault · Steward')
        : item('vault', 'vault', 'My vault', 'Person vault · Owner')}
      {item('shared', 'shared', 'Shared with me', sharedCount > 0 ? `${sharedCount} grants` : 'Inbound grants')}
      {item('public', 'public', 'Public releases', 'Published network-wide')}
    </div>
  );
}

function Breadcrumb({ lens, path, onGo }: { lens: Lens; path: string[]; onGo: (segs: string[]) => void }) {
  if (lens !== 'vault') return <b style={{ fontSize: 14 }}>{lens === 'shared' ? 'Shared with me' : 'Public releases'}</b>;
  return (
    <nav aria-label="Breadcrumb" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 14, flexWrap: 'wrap' }}>
      <button style={crumbSty} onClick={() => onGo([])}>All items</button>
      {path.map((seg, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="chevron" size={12} style={{ color: 'var(--color-text-muted)' }} />
          <button style={crumbSty} onClick={() => onGo(path.slice(0, i + 1))}>{seg}</button>
        </span>
      ))}
    </nav>
  );
}
const crumbSty: CSSProperties = { ...btnSty, background: 'none', border: 'none', padding: '0 2px', fontWeight: 600, color: 'var(--color-text-primary)', cursor: 'pointer' };

// ── the calm, provenance-first list ──
function ArtifactList({ rows, selectedId, ownerLabel, onOpen, onDescend }: {
  rows: Artifact[]; selectedId: string | null; ownerLabel: string; onOpen: (id: string) => void; onDescend: (name: string) => void;
}) {
  return (
    <div style={{ ...cardSty, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1.1fr .8fr .8fr 1fr .5fr', gap: '.5rem', padding: '.5rem .8rem', ...mutedText, fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', borderBottom: '1px solid var(--color-border)' }}>
        <span>Name</span><span>Owner</span><span>Access</span><span>Fresh</span><span>Authority</span><span>Ver</span>
      </div>
      {rows.map((a) => {
        const mode: AccessMode = a.accessMode ?? 'Owned';
        const fresh: Freshness = mode !== 'Owned' ? 'Cached' : freshnessOf(a);
        const owner = a.sharedBy ? shortAddr(a.sharedBy) : ownerLabel;
        const authority = a.myActions?.length ? a.myActions.join(' · ') : authorityText(mode);
        const on = a.id === selectedId;
        const activate = () => (a.isFolder ? onDescend(a.name) : onOpen(a.id));
        return (
          <div key={a.id} role="button" tabIndex={0}
            onClick={activate} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }}
            style={{ display: 'grid', gridTemplateColumns: '2.2fr 1.1fr .8fr .8fr 1fr .5fr', gap: '.5rem', alignItems: 'center', padding: '.55rem .8rem', minHeight: 44, cursor: 'pointer',
              borderBottom: '1px solid var(--color-border)', background: on ? 'var(--color-amber-50)' : 'transparent' }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--color-surface-sunken)'; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minWidth: 0 }}>
              <Icon name={a.isFolder ? 'folder' : KIND_META[a.kind].icon} size={17} style={{ color: 'var(--color-text-muted)' }} />
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span style={{ ...badgeStyle('neutral'), fontSize: 10 }}>{a.isFolder ? 'Folder' : KIND_META[a.kind].label}</span>
            </span>
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b>{owner}</b></span>
            <span><span style={{ ...badgeStyle(ACCESS_TONE[mode]), fontSize: 11 }}>{mode}</span></span>
            <span>{a.isFolder ? <span style={{ ...mutedText, fontSize: 12 }}>—</span> : <span style={{ ...badgeStyle(FRESH_TONE[fresh]), fontSize: 11 }}>{fresh}</span>}</span>
            <span style={{ ...mutedText, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{authority}</span>
            <span style={{ ...mono, ...mutedText, fontSize: 12 }}>{a.isFolder ? '—' : `v${a.version ?? 1}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function FederatedPlaceholder({ lens }: { lens: Lens }) {
  return (
    <div style={{ ...cardSty, padding: '1.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <Icon name={lens === 'shared' ? 'shared' : 'public'} size={20} style={{ color: 'var(--color-text-muted)' }} />
        <h3 style={{ margin: 0 }}>{lens === 'shared' ? 'Shared with me' : 'Public releases'}</h3>
      </div>
      <p style={{ ...mutedText, marginTop: '.5rem', maxWidth: 520 }}>
        {lens === 'shared'
          ? 'A federated view of artifacts other vaults have granted you — inbound entitlements across every Person, Organization, and Service vault you can reach via A2A + MCP.'
          : 'A network-wide view of published releases you can open, request access to, or fork — no grant required to discover them.'}
      </p>
      <p style={{ ...mutedText, fontSize: 12, marginTop: '.4rem' }}>Not yet available — the {lens === 'shared' ? 'inbound-grant' : 'public-release'} index lands in Phase 1b (see docs/architecture/agentic-content-fabric.md §8).</p>
    </div>
  );
}

// ── detail / workspace panel — progressive disclosure, one primary action + overflow ──
type Tab = 'content' | 'access' | 'provenance' | 'versions';
function DetailPanel({ artifact, items, ownerLabel, ownerVaultKind, folders, onClose, onGrant, onRevoke, onDiscuss, onMove, onRemove, onOpenMember, onOpenLive, onRequestAccess, onPublish }: {
  artifact: Artifact; items: Artifact[]; ownerLabel: string; ownerVaultKind: string; folders: string[];
  onClose: () => void; onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void; onRevoke: (id: string, addr: string) => void;
  onDiscuss: (id: string) => void; onMove: (a: Artifact, dest: string) => void; onRemove: (a: Artifact) => void; onOpenMember: (id: string) => void;
  onOpenLive: (a: Artifact) => Promise<Artifact>; onRequestAccess: (a: Artifact, actions: string[]) => Promise<void>;
  onPublish: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('content');
  const [menuOpen, setMenuOpen] = useState(false);
  const [live, setLive] = useState<Artifact | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const isBundle = artifact.isFolder || artifact.kind === 'skill';
  const publishable = artifact.kind === 'skill' || artifact.isFolder === true;
  const owned = (artifact.accessMode ?? 'Owned') === 'Owned';
  const members = useMemo(() => (artifact.isFolder ? items.filter((x) => x.folder === fullPath(artifact)) : []), [artifact, items]);

  const openLive = async () => { setLiveErr(null); setOpening(true); try { setLive(await onOpenLive(artifact)); setTab('content'); } catch (e) { setLiveErr((e as Error).message); } finally { setOpening(false); } };

  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  return (
    <aside style={{ ...cardSty, width: 400, flexShrink: 0, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '.5rem', padding: '.8rem .9rem', borderBottom: '1px solid var(--color-border)' }}>
        <Icon name={artifact.isFolder ? 'folder' : KIND_META[artifact.kind].icon} size={20} style={{ color: 'var(--color-text-muted)', marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis' }} tabIndex={-1}>{artifact.name}</h2>
          <div style={{ ...mutedText, fontSize: 12 }}>{artifact.isFolder ? 'Folder' : KIND_META[artifact.kind].label} · v{artifact.version ?? 1}{!owned && artifact.sharedBy ? ` · shared by ${shortAddr(artifact.sharedBy)}` : ''}</div>
        </div>
        <div style={{ position: 'relative' }}>
          <button style={{ ...btnSty, display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>More<Icon name="chevron" size={12} style={{ transform: 'rotate(90deg)' }} /></button>
          {menuOpen && (
            <div role="menu" style={{ ...cardSty, position: 'absolute', right: 0, top: '110%', zIndex: 5, minWidth: 180, padding: 4 }} onMouseLeave={() => setMenuOpen(false)}>
              {owned ? (
                <>
                  {publishable && <MenuItem label="Publish release" onClick={() => { setMenuOpen(false); onPublish(artifact.id); setTab('provenance'); }} />}
                  <MenuItem label="New version" hint="Phase 1b" disabled />
                  <MenuItem label="Discuss" onClick={() => { setMenuOpen(false); onDiscuss(artifact.id); }} />
                  <MoveMenu artifact={artifact} folders={folders} onMove={(d) => { setMenuOpen(false); onMove(artifact, d); }} />
                  <MenuItem label="Transfer ownership" hint="Phase 5b" disabled />
                  <MenuItem label="Remove from vault" danger onClick={() => { setMenuOpen(false); onRemove(artifact); }} />
                </>
              ) : (
                <>
                  <MenuItem label="Discuss" onClick={() => { setMenuOpen(false); onDiscuss(artifact.id); }} />
                  <MenuItem label="Request more access" hint="Phase 3" disabled />
                  <MenuItem label="Request replica" hint="Phase 3" disabled />
                </>
              )}
            </div>
          )}
        </div>
        <button style={{ ...btnSty, background: 'none', border: 'none', padding: 2, color: 'var(--color-text-muted)' }} onClick={onClose} aria-label="close"><Icon name="close" size={18} /></button>
      </div>

      <div role="tablist" style={{ display: 'flex', gap: 2, padding: '.4rem .6rem 0', borderBottom: '1px solid var(--color-border)' }}>
        {(['content', 'access', 'provenance', 'versions'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            style={{ ...btnSty, border: 'none', borderRadius: 0, borderBottom: `2px solid ${tab === t ? 'var(--color-amber-500)' : 'transparent'}`, color: tab === t ? 'var(--color-amber-700)' : 'var(--color-text-muted)', fontWeight: tab === t ? 700 : 500, textTransform: 'capitalize', padding: '.35rem .5rem' }}>{t}</button>
        ))}
      </div>

      <div style={{ padding: '.8rem .9rem', overflowY: 'auto', flex: 1 }}>
        {tab === 'content' && (isBundle
          ? <Members artifact={artifact} members={members} onOpenMember={onOpenMember} />
          : owned ? <ContentPreview artifact={artifact} />
          : <SharedContent artifact={live ?? artifact} hasLive={!!live} opening={opening} liveErr={liveErr} onOpenLive={openLive} />)}
        {tab === 'access' && (owned
          ? <AccessTab artifact={artifact} onGrant={onGrant} onRevoke={onRevoke} />
          : <SharedAccess artifact={artifact} onRequestAccess={onRequestAccess} />)}
        {tab === 'provenance' && <ProvenanceTab artifact={artifact} ownerLabel={owned ? ownerLabel : (artifact.sharedBy ? shortAddr(artifact.sharedBy) : 'Another vault')} ownerVaultKind={owned ? ownerVaultKind : `${artifact.sharedByKind ?? 'Person'} vault`} publishable={publishable} owned={owned} onPublish={() => onPublish(artifact.id)} />}
        {tab === 'versions' && <VersionsTab version={artifact.version ?? 1} />}
      </div>

      <div style={{ padding: '.7rem .9rem', borderTop: '1px solid var(--color-border)' }}>
        <button style={{ ...btnPrimarySty, width: '100%' }} disabled={opening} onClick={() => (owned ? setTab('access') : void openLive())}>{owned ? 'Manage access' : opening ? 'Opening…' : 'Open live'}</button>
      </div>
    </aside>
  );
}

function MenuItem({ label, onClick, hint, danger, disabled }: { label: string; onClick?: () => void; hint?: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick}
      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left', padding: '.4rem .5rem', border: 'none', background: 'transparent', cursor: disabled ? 'default' : 'pointer', color: disabled ? 'var(--color-text-muted)' : danger ? 'var(--color-danger)' : 'var(--color-text-body)', fontSize: 13, borderRadius: 6 }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--color-surface-sunken)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      <span style={{ flex: 1 }}>{label}</span>{hint && <span style={{ ...mutedText, fontSize: 10 }}>{hint}</span>}
    </button>
  );
}
function MoveMenu({ artifact, folders, onMove }: { artifact: Artifact; folders: string[]; onMove: (dest: string) => void }) {
  return (
    <div role="menuitem" style={{ padding: '.3rem .5rem' }}>
      <span style={{ fontSize: 13 }}>Move to…</span>
      <select style={{ ...inputSty, fontSize: 12, width: '100%', marginTop: 4 }} value="" onChange={(e) => { if (e.target.value !== '') onMove(e.target.value === '__root__' ? '' : e.target.value); }}>
        <option value="">Choose folder…</option>
        {folders.filter((f) => f !== artifact.folder).map((f) => <option key={f || '__root__'} value={f === '' ? '__root__' : f}>{f === '' ? 'All items (root)' : `/${f}`}</option>)}
      </select>
    </div>
  );
}

function ContentPreview({ artifact }: { artifact: Artifact }) {
  if (artifact.source !== 'blob' || !artifact.bytesB64) {
    return (
      <div>
        <p style={{ ...mutedText, fontSize: 13 }}>This artifact&apos;s bytes live in <b>{artifact.source}</b>{artifact.pointer ? <> at <span style={mono}>{artifact.pointer}</span></> : null}. Opening it live streams from the owning vault via MCP.</p>
        <p style={{ ...mutedText, fontSize: 12, marginTop: '.4rem' }}>Live MCP read arrives in Phase 3 (the two-vault read path).</p>
      </div>
    );
  }
  let text = '';
  try { text = atob(artifact.bytesB64); } catch { text = ''; }
  if (artifact.kind === 'image') return <img alt={artifact.name} src={`data:${artifact.contentType};base64,${artifact.bytesB64}`} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--color-border)' }} />;
  const pretty = artifact.kind === 'json-ld' ? (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() : text;
  return (
    <div>
      <pre style={{ ...mono, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 380, overflow: 'auto', background: 'var(--color-surface-sunken)', padding: '.6rem', borderRadius: 6 }}>{pretty}</pre>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: '.5rem', ...badgeStyle('ok'), fontSize: 11 }}><Icon name="check" size={12} />Content commitment verified</div>
    </div>
  );
}

function Members({ artifact, members, onOpenMember }: { artifact: Artifact; members: Artifact[]; onOpenMember: (id: string) => void }) {
  if (!artifact.isFolder) {
    // A skill bundle is a directory of typed members (SKILL.md + queries/code/schema/media). The demo
    // stores a skill as one entry today; directory members arrive with content-storage bundle storage.
    return (
      <div>
        <p style={{ ...mutedText, fontSize: 13 }}>A skill is a <b>directory</b> — a SKILL.md plus the SPARQL queries, code, schemas, and media that realize it (typed bundle members).</p>
        <p style={{ ...mutedText, fontSize: 12, marginTop: '.4rem' }}>This demo stores the skill as a single entry; role-typed directory members (content-storage <span style={mono}>bundle</span>) surface in Phase 1b.</p>
      </div>
    );
  }
  return (
    <div>
      <div style={{ ...mutedText, fontSize: 12, marginBottom: '.4rem' }}>Members ({members.length}) — everything under this folder inherits its access.</div>
      {members.length === 0 && <p style={mutedText}>This folder is empty.</p>}
      <div style={{ borderLeft: '1px solid var(--color-border)', paddingLeft: '.7rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {members.map((m) => (
          <button key={m.id} onClick={() => !m.isFolder && onOpenMember(m.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', border: 'none', background: 'transparent', padding: '.35rem 0', cursor: m.isFolder ? 'default' : 'pointer', color: 'var(--color-text-muted)' }}>
            <Icon name={m.isFolder ? 'folder' : KIND_META[m.kind].icon} size={15} />
            <span style={{ fontSize: 13, color: 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
            <span style={{ ...badgeStyle('neutral'), fontSize: 10, marginLeft: 'auto' }}>{m.isFolder ? 'Folder' : KIND_META[m.kind].label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AccessTab({ artifact, onGrant, onRevoke }: { artifact: Artifact; onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void; onRevoke: (id: string, addr: string) => void }) {
  const [addr, setAddr] = useState(''); const [gkind, setGkind] = useState('person'); const [label, setLabel] = useState(''); const [actions, setActions] = useState<string[]>(['read']);
  const toggle = (x: string) => setActions((a) => (a.includes(x) ? a.filter((y) => y !== x) : [...a, x]));
  const isFolder = artifact.isFolder === true;
  const inherited = (artifact.effectiveGrants ?? []).filter((g) => g.inheritedFrom && !g.revoked);
  const active = artifact.grants.filter((g) => !g.revoked);
  return (
    <div>
      <p style={{ ...mutedText, fontSize: 12, margin: '0 0 .6rem' }}>
        {isFolder
          ? <>Granting a folder <b>cascades to everything in and under it</b> — one entitlement covers the whole subtree, paired with a scoped, revocable delegation (the grantee is a delegate, never a custodian).</>
          : <>Each grant mints a signed, revocable entitlement plus a scoped delegation. No standing access beyond what&apos;s listed here.</>}
      </p>

      {inherited.length > 0 && (
        <div style={{ marginBottom: '.5rem' }}>
          {inherited.map((g, i) => (
            <div key={`inh-${g.grantee.address}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '.3rem 0', ...mutedText, fontSize: 12 }}>
              <Icon name="shared" size={13} />
              <span><b>{g.grantee.label ?? shortAddr(g.grantee.address)}</b> · {g.grantee.kind} · {g.actions.join(', ')}</span>
              <span style={{ ...badgeStyle('neutral'), fontSize: 10, marginLeft: 'auto' }}>inherited from {g.inheritedFrom}</span>
            </div>
          ))}
        </div>
      )}

      {active.length === 0 && <p style={{ ...mutedText, fontSize: 12 }}>{isFolder ? 'No folder-level access granted yet.' : inherited.length ? 'No direct grants (access is inherited above).' : 'No one else has access yet.'}</p>}
      {artifact.grants.map((g) => (
        <div key={g.grantee.address} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '.4rem 0', borderBottom: '1px solid var(--color-border)', opacity: g.revoked ? 0.5 : 1 }}>
          <span style={{ minWidth: 0 }}><b style={{ fontSize: 13 }}>{g.grantee.label ?? shortAddr(g.grantee.address)}</b> <span style={{ ...mutedText, fontSize: 12 }}>· {g.grantee.kind} · {g.actions.join(', ')}</span></span>
          {!g.revoked && <span style={{ ...badgeStyle(g.signed ? 'ok' : 'neutral'), fontSize: 10 }}>{g.signed ? 'Signed' : 'Unsigned'}</span>}
          {!g.revoked && g.delegation && <span style={{ ...badgeStyle('ok'), fontSize: 10 }}>Delegated</span>}
          {g.revoked ? <span style={{ ...mutedText, fontSize: 12, marginLeft: 'auto' }}>revoked</span> : <button style={{ ...btnSty, marginLeft: 'auto', padding: '.2rem .5rem', fontSize: 12 }} onClick={() => onRevoke(artifact.id, g.grantee.address)}>Revoke</button>}
        </div>
      ))}

      <div style={{ marginTop: '.7rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
        <input style={inputSty} placeholder="grantee SA 0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
        <div style={{ display: 'flex', gap: '.4rem' }}>
          <select style={{ ...inputSty, flex: 1 }} value={gkind} onChange={(e) => setGkind(e.target.value)}>{['person', 'org', 'service'].map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <input style={{ ...inputSty, flex: 1 }} placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
          {ACTIONS.map((x) => (<label key={x} style={{ ...mutedText, fontSize: 12, display: 'inline-flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={actions.includes(x)} onChange={() => toggle(x)} />{x}</label>))}
        </div>
        <button style={btnPrimarySty} disabled={!/^0x[0-9a-fA-F]{40}$/.test(addr) || actions.length === 0} onClick={() => { onGrant(artifact.id, addr, gkind, actions, label || undefined); setAddr(''); setLabel(''); }}>Grant access</button>
      </div>
    </div>
  );
}

function SharedAccess({ artifact, onRequestAccess }: { artifact: Artifact; onRequestAccess: (a: Artifact, actions: string[]) => Promise<void> }) {
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = async () => { setBusy(true); try { await onRequestAccess(artifact, ['read', 'write']); setRequested(true); } finally { setBusy(false); } };
  const entId = (artifact as { entitlementId?: string }).entitlementId;
  return (
    <div>
      <p style={{ ...mutedText, fontSize: 12, margin: '0 0 .6rem' }}>This artifact lives in another vault. You hold a scoped entitlement (and delegation) to it — you&apos;re a delegate, not a custodian.</p>
      <Field label="Access mode"><span style={{ ...badgeStyle('neutral'), fontSize: 11 }}>{artifact.accessMode ?? 'Read-through'}</span></Field>
      <Field label="Shared by"><b>{artifact.sharedBy ? shortAddr(artifact.sharedBy) : 'Another vault'}</b> <span style={mutedText}>· {artifact.sharedByKind ?? 'person'}</span></Field>
      <Field label="Your actions">{artifact.myActions?.length ? artifact.myActions.join(' · ') : 'read'}</Field>
      {entId ? <Field label="Entitlement"><span style={mono}>{entId}</span></Field> : null}
      {requested
        ? <div style={{ ...badgeStyle('ok'), display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: '.4rem' }}><Icon name="check" size={12} />Requested — awaiting the owner&apos;s response</div>
        : <button style={{ ...btnSty, marginTop: '.4rem' }} disabled={busy} onClick={() => void request()}>{busy ? 'Requesting…' : 'Request more access (read + write)'}</button>}
    </div>
  );
}

function SharedContent({ artifact, hasLive, opening, liveErr, onOpenLive }: { artifact: Artifact; hasLive: boolean; opening: boolean; liveErr: string | null; onOpenLive: () => void }) {
  if (hasLive) {
    return (
      <div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: '.5rem', ...badgeStyle('ok'), fontSize: 11 }}><Icon name="check" size={12} />Served live by the owner&apos;s vault{artifact.sharedBy ? ` (${shortAddr(artifact.sharedBy)})` : ''}</div>
        {artifact.source === 'blob' && artifact.bytesB64
          ? (artifact.kind === 'image'
            ? <img alt={artifact.name} src={`data:${artifact.contentType};base64,${artifact.bytesB64}`} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--color-border)' }} />
            : <pre style={{ ...mono, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 360, overflow: 'auto', background: 'var(--color-surface-sunken)', padding: '.6rem', borderRadius: 6 }}>{(() => { try { return atob(artifact.bytesB64); } catch { return ''; } })()}</pre>)
          : <p style={{ ...mutedText, fontSize: 13 }}>Stored in <b>{artifact.source}</b>{artifact.pointer ? <> at <span style={mono}>{artifact.pointer}</span></> : null}.</p>}
      </div>
    );
  }
  return (
    <div style={{ textAlign: 'center', padding: '1rem 0' }}>
      <p style={{ ...mutedText, fontSize: 13, maxWidth: 300, margin: '0 auto .7rem' }}>This artifact lives in another vault. Opening it streams a copy from the owner&apos;s vault, which re-checks your grant before releasing.</p>
      {liveErr && <p style={{ ...errorText, fontSize: 12 }}>{liveErr}</p>}
      <button style={btnPrimarySty} disabled={opening} onClick={onOpenLive}>{opening ? 'Opening…' : 'Open live'}</button>
    </div>
  );
}

function RequestsBanner({ requests, onApprove }: { requests: { requester: string; artifactId: string; artifactName?: string; actions: string[]; at: number }[]; onApprove: (r: { requester: string; artifactId: string; actions: string[] }) => void }) {
  return (
    <div style={{ ...infoBannerSty, marginBottom: '.6rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '.4rem' }}>
        <Icon name="shared" size={16} /><b style={{ fontSize: 13 }}>{requests.length} access {requests.length === 1 ? 'request' : 'requests'}</b>
      </div>
      {requests.map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '.3rem 0', fontSize: 13 }}>
          <span><b>{shortAddr(r.requester)}</b> <span style={mutedText}>requests {r.actions.join(', ')} on {r.artifactName ?? r.artifactId}</span></span>
          <button style={{ ...btnPrimarySty, marginLeft: 'auto', padding: '.25rem .6rem', fontSize: 12 }} onClick={() => onApprove(r)}>Approve</button>
        </div>
      ))}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '.7rem' }}>
      <div style={{ ...mutedText, fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}
function ProvenanceTab({ artifact, ownerLabel, ownerVaultKind, publishable, owned, onPublish }: { artifact: Artifact; ownerLabel: string; ownerVaultKind: string; publishable?: boolean; owned?: boolean; onPublish?: () => void }) {
  const resource = artifact.isFolder ? `container:${fullPath(artifact)}` : `artifact:${artifact.id}`;
  const releases = artifact.releases ?? [];
  return (
    <div>
      {publishable && (
        <div style={{ marginBottom: '.8rem', paddingBottom: '.7rem', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '.4rem' }}>
            <div style={{ ...mutedText, fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>Releases ({releases.length})</div>
            {owned && onPublish && <button style={{ ...btnSty, marginLeft: 'auto', padding: '.2rem .5rem', fontSize: 12 }} onClick={onPublish}>Publish release</button>}
          </div>
          {releases.length === 0
            ? <div style={{ ...mutedText, fontSize: 12 }}>No releases yet. Publishing signs a location-independent release (owner = publisher here).</div>
            : [...releases].reverse().map((r) => (
              <div key={r.releaseId} style={{ padding: '.4rem 0', borderBottom: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ ...mono, fontSize: 12, fontWeight: 700 }}>v{r.version}</span>
                  <span style={{ ...badgeStyle(r.signed ? 'ok' : 'neutral'), fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}>{r.signed && <Icon name="check" size={11} />}{r.signed ? 'Signed' : 'Unsigned'}</span>
                  <span style={{ ...badgeStyle('neutral'), fontSize: 10, marginLeft: 'auto' }}>risk: {r.riskTier}</span>
                </div>
                <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>release <span style={mono}>{r.releaseId.slice(0, 10)}…</span> · publisher {shortAddr(r.publisher)}</div>
              </div>
            ))}
        </div>
      )}
      <Field label="Resource id"><span style={mono}>{resource}</span></Field>
      {releases[0] && <Field label="Canonical id (published)"><span style={{ ...mono, fontSize: 12 }}>{releases[0].canonicalId.slice(0, 12)}…{releases[0].canonicalId.slice(-6)}</span> <span style={{ ...mutedText, fontSize: 11 }}>· location-independent</span></Field>}
      <Field label="Owner vault"><b>{ownerLabel}</b> <span style={mutedText}>· {ownerVaultKind}</span></Field>
      <Field label="Source"><span style={mono}>{artifact.source}</span>{artifact.pointer ? <> · <span style={mono}>{artifact.pointer}</span></> : null}</Field>
      <Field label="Canonical id"><span style={{ ...mutedText }}>Assigned on publish (skill:&lt;ns&gt;/&lt;name&gt;) — Phase 5</span></Field>
      <Field label="Content commitment">
        {artifact.contentCommitment
          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ ...mono, fontSize: 12 }}>{artifact.contentCommitment.slice(0, 10)}…{artifact.contentCommitment.slice(-6)}</span><span style={{ ...badgeStyle('ok'), fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="check" size={11} />Verified</span></span>
          : <span style={mutedText}>{artifact.source === 'blob' ? 'Computed on next save' : 'Held with the owning store'}</span>}
      </Field>
      <Field label="Containment root"><span style={mutedText}>{artifact.isFolder ? 'Merkle subtree root — Phase 1b' : 'n/a (leaf artifact)'}</span></Field>
      <p style={{ ...mutedText, fontSize: 11, marginTop: '.4rem' }}>Provenance is the model&apos;s trust surface: who owns this, which exact bytes, where in the append-only log. Verification is fail-closed — an unverified commitment will say so here, never be silently omitted.</p>
    </div>
  );
}
function VersionsTab({ version }: { version: number }) {
  return (
    <div>
      {Array.from({ length: version }, (_, i) => version - i).map((v) => (
        <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '.5rem 0', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ ...mono, fontSize: 12 }}>v{v}</span>
          {v === version && <span style={{ ...badgeStyle('ok'), fontSize: 10 }}>current</span>}
          <span style={{ ...mutedText, fontSize: 12, marginLeft: 'auto' }}>{v === version ? 'latest' : 'superseded'}</span>
        </div>
      ))}
      <p style={{ ...mutedText, fontSize: 12, marginTop: '.6rem' }}>Versioning is an append-only Merkle transparency log — history is never mutated or deleted, only advanced. Re-saving an artifact advances its version. Per-version content + publish lands with signed storage.</p>
    </div>
  );
}

// ── upload modal (preserved; glyph → Icon) ──
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
      <div role="dialog" aria-modal="true" aria-label="Add to vault" style={{ ...cardSty, width: 'min(560px, 92vw)', maxHeight: '85dvh', overflowY: 'auto', padding: '1.25rem' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <h3 style={{ margin: 0, flex: 1 }}>Add to vault</h3>
          <select style={{ ...inputSty, fontSize: 12 }} value={dest} onChange={(e) => setDest(e.target.value)} aria-label="destination folder">
            {folders.map((f) => <option key={f || '__root__'} value={f === '' ? '__root__' : f}>{f === '' ? '→ All items' : `→ /${f}`}</option>)}
          </select>
          <button style={{ ...btnSty, background: 'none', border: 'none', padding: 2, color: 'var(--color-text-muted)' }} onClick={onClose} aria-label="close"><Icon name="close" size={18} /></button>
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
                  <Icon name={KIND_META[kindFor(r.file ?? new File([], r.name))].icon} size={15} style={{ color: 'var(--color-text-muted)' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ ...mutedText, fontSize: 12 }}>{fmtSize(r.size)}</span>
                  <span style={{ fontSize: 12, ...(r.status === 'skipped' ? errorText : r.status === 'done' ? { color: 'var(--color-amber-700)' } : mutedText) }}>{r.status === 'queued' ? 'queued' : r.status === 'uploading' ? 'uploading…' : r.status === 'done' ? 'done' : 'over 1.4 MB'}</span>
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
              <select style={inputSty} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}</select>
              <select style={inputSty} value={source} onChange={(e) => setSource(e.target.value as Source)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            </div>
            {source === 'blob'
              ? <textarea style={{ ...inputSty, width: '100%', minHeight: 70, marginTop: '.5rem' }} placeholder="content" value={body} onChange={(e) => setBody(e.target.value)} />
              : <input style={{ ...inputSty, width: '100%', marginTop: '.5rem' }} placeholder="retrievalPointer (e.g. graphdb:faith/ontology · vault:0x…/record)" value={pointer} onChange={(e) => setPointer(e.target.value)} />}
            <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '.8rem' }}>
              <button style={btnSty} onClick={onClose}>Cancel</button>
              <button style={btnPrimarySty} onClick={() => void addRef()}>Add to {dest === '__root__' || dest === '' ? 'All items' : `/${dest}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const segSty = (on: boolean): CSSProperties => ({ ...btnSty, borderRadius: 0, background: on ? 'var(--color-amber-50)' : 'transparent', color: on ? 'var(--color-amber-700)' : undefined, fontWeight: on ? 700 : undefined });
