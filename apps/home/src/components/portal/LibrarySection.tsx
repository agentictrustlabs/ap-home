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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSession } from '../../context/session';
import { nameLabel, personalAuthOrigin } from '../../lib/domain';
import { whitelabel } from '../../whitelabel/config';

/** Spec 412 — which connected APP a top-level folder belongs to, from the registry (an app declares where it writes). */
const APP_FOLDERS: ReadonlyMap<string, string> = new Map(whitelabel.relyingApps.flatMap((a) => (a.libraryFolders ?? []).map((f) => [f, a.name ?? a.client_id] as [string, string])));
const appOfFolder = (folder: string): string | null => APP_FOLDERS.get(folder.split('/')[0] ?? '') ?? null;
import { SectionShell } from './SectionShell';
import { cardSty, btnSty, btnPrimarySty, mono, mutedText, errorText, inputSty, badgeStyle, modalOverlaySty, infoBannerSty, shortAddr, type BadgeKind } from './theme';
import { artifactIdentity } from '../../home/artifact-identity';
import { SkeletonRows, EmptyState, Button, Tabs, Drawer, Chip, Meta, KeyValue, Micro, useReadyReport } from '../../ui';
import { useManagedAgents } from './ManagedAgents';
import { agentClassOf } from '../../lib/agent-class';
import { vaultReadWithDelegation } from '../../lib/vault-client';
import type { DelegationWire } from '../../lib/delegation';
import { readHeldAgentCatalog, readHeldAgentArtifactBody } from '../../home/held-agent-library';

/** Said when a steward tries to change a HELD agent's Library from Home — this view only reads it. */
const HELD_READ_ONLY = 'This Library is read over your stewardship delegation and is read-only here — the agent (or the app that runs it) keeps its own Library.';

type Kind = 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
type Source = 'blob' | 'graphdb' | 'vault' | 'external';
type Sort = 'name' | 'kind' | 'newest' | 'freshness';
type AccessMode = 'Owned' | 'Read-through' | 'Replica' | 'Public' | 'Projection';
type Freshness = 'Live' | 'Signed' | 'Cached' | 'Stale' | 'Unavailable';
// Where you are: your own vault (navigated by FOLDER) or the place other vaults granted you into. "Public" is not a place —
// it is a property of a file or folder — so it is a FILTER on wherever you are, never a third lens.
type Lens = 'vault' | 'shared';
interface Grant { grantee: { address: string; kind: string; label?: string }; actions: string[]; grantedAt: number; revoked?: boolean; entitlementId?: string; resource?: string; signed?: boolean; inheritedFrom?: string; delegation?: { caveats?: unknown[] } }
interface Release { canonicalId: string; version: string; bundleRoot: string; owner: string; publisher: string; riskTier: string; releaseId: string; signed: boolean; publishedAt: number }
type AccessPolicy = 'public' | 'private';
interface Artifact { id: string; kind: Kind; name: string; source: Source; folder: string; isFolder?: boolean; pointer?: string; discussionId?: string; contentType: string; bytesB64?: string; size: number; createdAt: number; version?: number; contentCommitment?: string; grants: Grant[]; effectiveGrants?: Grant[]; releases?: Release[];
  /** Spec 412 — the owner's declaration (`apcnt:accessPolicy`) and what it comes to after the folder cascade. */
  accessPolicy?: AccessPolicy; effectiveAccessPolicy?: AccessPolicy;
  // present on "Shared with me" rows (a federated inbound grant from another vault)
  accessMode?: AccessMode; sharedBy?: string; sharedByKind?: string; myActions?: string[] }
interface TreeNode { name: string; path: string; children: TreeNode[] }

/** The shape of the list while the vault is being read — never the empty state. */
function LibrarySkeleton() { return <SkeletonRows rows={4} />; }

const KINDS: Kind[] = ['skill', 'ttl', 'md', 'json-ld', 'image'];
const SOURCES: Source[] = ['blob', 'graphdb', 'vault', 'external'];
const ACTIONS = ['read', 'write', 'share', 'export', 'delete'];
const MAX_UPLOAD_BYTES = 1_400_000;

// Kind → the WORD the UI shows + its icon. Words carry meaning; icons aid scanning (paired, never alone).
const KIND_META: Record<Kind, { label: string; plural: string; icon: IconName }> = {
  skill: { label: 'Playbook', plural: 'Playbooks', icon: 'skill' }, // SKILL.md package (ADR-0051)
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

export function LibrarySection({ orgSa, heldAgent }: {
  orgSa?: string;
  /** An agent the person HOLDS (a service, a persona — `/service/<agent>/library`). Its Library is read from its OWN
   *  vault over the stewardship delegation, exactly as its Records page reads it (`home/held-agent-library.ts`). */
  heldAgent?: string;
}) {
  const { session, agentAddress, agentName } = useSession();
  const token = session?.token ?? '';
  const scopeSa = orgSa ?? heldAgent;
  const scopeQ = scopeSa ? `?org=${scopeSa}` : '';
  const ownerSa = (heldAgent ?? orgSa ?? agentAddress ?? '').toLowerCase();
  // Resolved only for a held agent — no managed-agents read for a person's or an organization's Library.
  const managed = useManagedAgents(heldAgent ? (token || null) : null, 'any');
  const heldSvc = heldAgent ? managed.agents.find((a) => a.agent.toLowerCase() === heldAgent.toLowerCase()) : undefined;
  const heldDelegation = (heldSvc?.stewardshipDelegation as DelegationWire | undefined) ?? null;
  const heldClass = heldSvc ? agentClassOf(heldSvc.kind) : null;
  const [items, setItems] = useState<Artifact[]>([]);
  const [sharedItems, setSharedItems] = useState<Artifact[]>([]);
  const [requests, setRequests] = useState<{ requester: string; artifactId: string; artifactName?: string; actions: string[]; at: number }[]>([]);
  // Spec 412 — where the list came from: her vault (what her agent serves), or this Home's cache (what an app wrote under a
  // token that cannot write her vault). `cache` offers to move it; said, never hidden.
  const [source, setSource] = useState<'vault' | 'cache' | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sharedLoading, setSharedLoading] = useState(false);
  useReadyReport('library-vault', loading);
  useReadyReport('library-shared', sharedLoading);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [lens, setLens] = useState<Lens>('vault');
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [kindFilter, setKindFilter] = useState<Kind | 'all'>('all');
  // Spec 412 — "Public only": the entries anyone can read, across the whole vault (a shelf is flat; a folder's public
  // word shows on each document under it as its own chip).
  const [publicOnly, setPublicOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const cwd = path.join('/');
  // `?open=<id>` (Today's artifact rows link here): once the vault has landed, select the item and stand in its folder.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading || typeof window === 'undefined') return;
    const want = new URLSearchParams(window.location.search).get('open');
    if (!want || openedRef.current === want) return;
    const hit = items.find((a) => a.id === want);
    if (!hit) return;
    openedRef.current = want;
    setPath(hit.folder ? hit.folder.split('/') : []);
    setSelectedId(hit.id);
  }, [loading, items]);

  const ownerLabel = heldAgent ? (heldSvc?.name || 'This agent') : orgSa ? 'This organization' : 'You';
  const ownerVaultKind = heldAgent ? (heldClass === 'service' ? 'Service vault' : 'Agent vault') : orgSa ? 'Organization vault' : 'Person vault';

  const api = useCallback(async (method: 'GET' | 'POST', payload?: unknown) => {
    if (heldAgent && method === 'POST') throw new Error(HELD_READ_ONLY);
    const r = await fetch(`/connect/library${scopeQ}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
    const b = await r.json().catch(() => ({}));
    if (r.status === 403) { const e = new Error(b.error ?? 'forbidden'); (e as { forbidden?: boolean }).forbidden = true; throw e; }
    if (!r.ok) throw new Error(b.error ?? `request failed (${r.status})`);
    return b;
  }, [token, scopeQ, heldAgent]);

  const load = useCallback(async () => {
    setErr(null);
    if (heldAgent) {
      // A HELD agent: its own vault, over the stewardship delegation — the read its Records page makes.
      if (!managed.loaded) return; // still resolving which agents you hold — keep the skeleton
      try {
        if (!heldSvc) throw new Error('You don’t hold an agent at this address.');
        if (!heldDelegation) throw new Error('No stewardship delegation on this agent — Home cannot read its Library from here.');
        setItems((await readHeldAgentCatalog(heldDelegation, vaultReadWithDelegation)) as unknown as Artifact[]);
        setRequests([]);
      } catch (e) { setErr((e as Error).message); }
      finally { setLoading(false); }
      return;
    }
    try { const b = await api('GET'); setItems(b.artifacts ?? []); setRequests(b.requests ?? []); setSource((b.source as 'vault' | 'cache' | undefined) ?? null); setForbidden(false); }
    catch (e) { if ((e as { forbidden?: boolean }).forbidden) setForbidden(true); else setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [api, heldAgent, managed.loaded, heldSvc, heldDelegation]);
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
  const publicCount = useMemo(() => items.filter((a) => !a.isFolder && a.effectiveAccessPolicy === 'public').length, [items]);
  const selected = useMemo(() => [...items, ...sharedItems].find((x) => x.id === selectedId) ?? null, [items, sharedItems, selectedId]);
  // A held agent's catalog entry may carry no body — the body is its own `content.artifact.<id>` record (ADR-0055).
  // Read it over the same delegation when the entry is opened, so Content shows what Records shows.
  const bodyTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!heldAgent || !heldDelegation || !selected || selected.isFolder || selected.bytesB64 || selected.accessMode) return;
    if (bodyTried.current.has(selected.id)) return;
    bodyTried.current.add(selected.id);
    const id = selected.id;
    void readHeldAgentArtifactBody(heldDelegation, id, vaultReadWithDelegation)
      .then((b) => { if (b) setItems((xs) => xs.map((x) => (x.id === id ? { ...x, bytesB64: b.bytesB64, ...(b.contentType ? { contentType: b.contentType } : {}) } : x))); })
      .catch((e) => setErr(`Couldn’t read ${selected.name}: ${(e as Error).message}`));
  }, [heldAgent, heldDelegation, selected]);

  // The current lens's rows. `vault` = your own vault at the current folder (or a search across it);
  // `shared` = the federated inbound-grant lens; `public` = the network registry (Phase 5).
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const rows = useMemo(() => {
    if (lens === 'vault' && publicOnly) return items.filter((a) => a.effectiveAccessPolicy === 'public' && !a.isFolder && (!searching || a.name.toLowerCase().includes(q)) && (kindFilter === 'all' || a.kind === kindFilter)).sort((a, b) => b.createdAt - a.createdAt);
    const source = lens === 'shared' ? sharedItems : items;
    let arr = lens === 'shared'
      ? (searching ? source.filter((a) => a.name.toLowerCase().includes(q)) : source)
      : source.filter((a) => (searching ? a.name.toLowerCase().includes(q) : a.folder === cwd));
    // FOLDERS ARE ROWS. A folder exists because something is in it (an item's `folder` path), whether or not a folder
    // record was written; at this level every immediate child folder is listed as a row — so the top level of a vault
    // whose items all live in folders never reads "Nothing in your vault yet" (seen live, 2026-09-13).
    if (lens === 'vault' && !searching) {
      const present = new Set(arr.filter((a) => a.isFolder).map((a) => a.name));
      const implicit = new Map<string, number>();
      for (const a of source) {
        if (a.isFolder ? !a.folder.startsWith(cwd) : !(a.folder === cwd || a.folder.startsWith(cwd ? `${cwd}/` : ''))) continue;
        const rest = a.isFolder ? fullPath(a) : a.folder;
        const below = cwd ? (rest.startsWith(`${cwd}/`) ? rest.slice(cwd.length + 1) : '') : rest;
        const child = below.split('/')[0];
        if (!child || (a.isFolder && rest === (cwd ? `${cwd}/${a.name}` : a.name) && a.folder === cwd)) continue;
        implicit.set(child, (implicit.get(child) ?? 0) + (a.isFolder ? 0 : 1));
      }
      for (const [name, count] of implicit) if (!present.has(name)) arr = [...arr, { id: `folder:${cwd ? `${cwd}/` : ''}${name}`, kind: 'md', name, source: 'blob', folder: cwd, isFolder: true, contentType: 'inode/directory', size: count, createdAt: 0, grants: [] } as Artifact];
    }
    if (kindFilter !== 'all') arr = arr.filter((a) => !a.isFolder && a.kind === kindFilter);
    return [...arr].sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1; // folders first
      return sort === 'kind' ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
        : sort === 'newest' ? b.createdAt - a.createdAt
        : sort === 'freshness' ? freshnessOf(a).localeCompare(freshnessOf(b))
        : a.name.localeCompare(b.name);
    });
  }, [items, sharedItems, lens, cwd, q, searching, sort, kindFilter, publicOnly]);

  // actions
  const select = (id: string | null) => setSelectedId(id);
  const descend = (folderName: string) => { setPath([...path, folderName]); setSelectedId(null); };
  const goTo = (segs: string[]) => { setPath(segs); setSelectedId(null); };
  const newFolder = async () => { const name = prompt('Folder name'); if (!name?.trim()) return; try { await api('POST', { action: 'save', org: orgSa, artifact: { name: name.trim(), kind: 'md', source: 'blob', folder: cwd, isFolder: true } }); await load(); } catch (e) { setErr((e as Error).message); } };
  const removeItem = async (a: Artifact) => {
    const hasChildren = a.isFolder && items.some((x) => x.folder === fullPath(a) || x.folder.startsWith(`${fullPath(a)}/`));
    const question = hasChildren
      ? `Delete "${a.name}" and everything inside it? This can't be undone.`
      : `Delete "${a.name}"? This can't be undone.`;
    if (!confirm(question)) return;
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
  // THE DOCUMENT ITSELF (owner, 2026-10-01: "I want to be able to view the actual document"). An organization's catalog is
  // an index — bytes live on `content.artifact.<id>` and a GET with `name=` hydrates exactly that one; a held agent's
  // body is read over the stewardship delegation. Called when the panel opens a file the listing gave no bytes for.
  const hydrate = useCallback(async (a: Artifact): Promise<Artifact> => {
    if (heldAgent) {
      if (!heldDelegation) throw new Error('No stewardship delegation on this agent — its document cannot be read from here.');
      const body = await readHeldAgentArtifactBody(heldDelegation, a.id, vaultReadWithDelegation);
      if (!body) throw new Error('This document carries no body in the vault.');
      return { ...a, ...body };
    }
    const q = new URLSearchParams();
    if (scopeSa) q.set('org', scopeSa);
    q.set('name', a.name);
    if (a.folder) q.set('folder', a.folder);
    const r = await fetch(`/connect/library?${q.toString()}`, { headers: { authorization: `Bearer ${token}` } });
    const b = (await r.json().catch(() => ({}))) as { artifacts?: Artifact[]; error?: string };
    if (!r.ok) throw new Error(b.error ?? `read failed (${r.status})`);
    const hit = (b.artifacts ?? []).find((x) => x.id === a.id) ?? (b.artifacts ?? []).find((x) => x.name === a.name && x.folder === a.folder);
    if (!hit?.bytesB64) throw new Error('The document could not be read from the vault.');
    return hit;
  }, [heldAgent, heldDelegation, scopeSa, token]);
  const requestAccess = useCallback(async (a: Artifact, actions: string[]) => { await api('POST', { action: 'request-access', ownerScope: a.sharedBy, id: a.id, actions, artifactName: a.name }); }, [api]);
  const publish = async (id: string) => { try { await api('POST', { action: 'publish', org: orgSa, id }); await load(); } catch (e) { setErr((e as Error).message); } };
  // Spec 412 — move this Home's cache into her vault, under her own session (the catalog + every document's record).
  const syncToVault = async () => {
    setSyncing(true); setErr(null);
    try {
      const r = await api('POST', { action: 'sync' });
      if (r.failed?.length) setErr(`${r.synced} moved; not moved: ${(r.failed as string[]).join(' · ')}`);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setSyncing(false); }
  };
  // Spec 412 — public / private is the owner's declaration on the record; the owner's agent serves what is public.
  const setVisibility = async (id: string, accessPolicy: AccessPolicy) => { try { await api('POST', { action: 'visibility', org: orgSa, id, accessPolicy }); await load(); } catch (e) { setErr((e as Error).message); } };
  // Where a public document of the PERSON's is read by anyone: her Home's `/published/<id>`. An organization's shelf is
  // served by its agent's public lane today and gets its page with the org Home (412 §4).
  const publicHref = (a: Artifact): string | null => (orgSa || a.isFolder ? null : `${personalAuthOrigin(nameLabel(agentName ?? ''))}/published/${encodeURIComponent(a.id)}`);
  const approveRequest = async (r: { requester: string; artifactId: string; actions: string[] }) => { await grant(r.artifactId, r.requester, 'person', r.actions.length ? r.actions : ['read']); };

  const writable = lens === 'vault' && !heldAgent;
  const title = heldAgent ? (heldClass === 'service' ? 'Service Library' : 'Library') : orgSa ? 'Organization Library' : 'Library';
  // Spec 412 — where the world reads what she made public: her Home's /published, rendered from her agent's public lane.
  const shelfHref = orgSa || heldAgent ? null : '/published';

  if (forbidden) return (
    <SectionShell wide title="Organization Library">
      <div style={{ ...cardSty, textAlign: 'center', padding: '2rem' }}>
        <div style={{ display: 'inline-flex', color: 'var(--color-text-muted)' }}><Icon name="lock" size={28} /></div>
        <h3 style={{ margin: '.4rem 0' }}>You&apos;re not a steward of this organization</h3>
        <p style={mutedText}>Only stewards can view or manage this organization&apos;s library.</p>
      </div>
    </SectionShell>
  );

  return (
    <SectionShell wide title={title} description="What this vault holds, who may see each item, and how fresh it is — shared, published or replicated as three separate acts.">
      {/* Explicit text color so every descendant inherits a defined token — never a white ambient
          (e.g. a browser/OS dark-mode default) on our light surfaces. */}
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start', color: 'var(--color-text-body)' }}>
        <FolderRail lens={lens} onLens={(l) => { setLens(l); setSelectedId(null); setPath([]); setPublicOnly(false); }} items={items} path={path} onGo={(segs) => { setLens('vault'); setPublicOnly(false); goTo(segs); }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', marginBottom: '.5rem' }}>
            <Breadcrumb lens={lens} path={path} onGo={goTo} />
            <div style={{ flex: 1 }} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...inputSty, padding: '.35rem .5rem' }}>
              <Icon name="search" size={14} style={{ color: 'var(--color-text-muted)' }} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${lens === 'vault' ? 'this vault' : lens === 'shared' ? 'shared items' : 'your public shelf'}…`} style={{ border: 'none', outline: 'none', background: 'transparent', color: 'inherit', width: 160 }} />
            </label>
            {shelfHref && <a href={shelfHref} target="_blank" rel="noreferrer" data-testid="public-shelf-link" style={{ ...btnSty, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }} title="What anyone can read of your Library — served by your own agent over A2A, the same way a stranger would read it">Your public shelf ↗</a>}
            {writable && <button style={{ ...btnPrimarySty, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setUploadOpen(true)}><Icon name="plus" size={14} />Add to vault</button>}
          </div>
          {/* Spec 412 — THE CACHE IS NOT THE VAULT. An app that saved here under its own token could not write your vault, so
              your agent (and your public shelf) never saw these. One act under your own session moves them. */}
          {!orgSa && source === 'cache' && items.length > 0 && (
            <div className="ui-card ui-card--quiet" data-testid="library-cache-banner" style={{ padding: 'var(--sp-3) var(--sp-4)', marginBottom: '.6rem', display: 'flex', gap: '.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 240, fontSize: 13 }}>
                <b>These {items.filter((a) => !a.isFolder).length} items are in this Home&apos;s cache, not your vault.</b> An app saved them under its own token, which cannot write your vault — so your agent cannot read them and none of them can be public yet. Moving them is your own act, under your session.
              </span>
              <Button variant="primary" size="sm" disabled={syncing} onClick={() => void syncToVault()} data-testid="library-sync">{syncing ? 'Moving…' : 'Move to my vault'}</Button>
            </div>
          )}
          {/* An app-owned folder says so: `publishing` is a bare word until the registry names who writes it. */}
          {lens === 'vault' && path.length > 0 && appOfFolder(path[0]!) && (
            <p style={{ ...mutedText, fontSize: 12, margin: '0 0 .5rem' }} data-testid="folder-app-note">
              <b>{path[0]}</b> is written by <b>{appOfFolder(path[0]!)}</b> — an app you connected. It saves here through your own agent, as you; what it saved is yours to make public, share or remove.
            </p>
          )}

          {/* filters */}
          {(
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.5rem' }}>
              <Tabs value={kindFilter} onChange={setKindFilter} label="Kind" items={(['all', ...KINDS] as const).map((k) => ({ id: k, label: k === 'all' ? 'All' : KIND_META[k].plural }))} />
              {lens === 'vault' && (
                <button type="button" aria-pressed={publicOnly} data-testid="public-only" onClick={() => setPublicOnly((v) => !v)}
                  title="Only what anyone can read — served by your own agent; the same list a stranger gets"
                  style={{ ...btnSty, display: 'inline-flex', alignItems: 'center', gap: 5, ...(publicOnly ? { background: 'var(--color-surface-sunken)', borderColor: 'var(--color-text-faint)' } : {}) }}>
                  <Icon name="public" size={13} />Public only{publicCount > 0 ? ` · ${publicCount}` : ''}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ ...mutedText, fontSize: 12 }}>Sort</span>
              <select style={{ ...inputSty, fontSize: 12, padding: '.3rem .4rem' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {(['name', 'kind', 'newest', 'freshness'] as Sort[]).map((s) => <option key={s} value={s}>{s === 'name' ? 'Name' : s === 'kind' ? 'Kind' : s === 'newest' ? 'Newest' : 'Freshness'}</option>)}
              </select>
              {writable && <button style={btnSty} onClick={() => void newFolder()}>New folder</button>}
            </div>
          )}

          {heldAgent && lens === 'vault' && <p style={{ ...mutedText, fontSize: 12, margin: '0 0 .5rem' }}>Read from this agent&rsquo;s own vault with your stewardship delegation (the agent &rarr; you) &mdash; the same read as its Records. Read-only here.</p>}
          {err && <p style={errorText}>{err}</p>}

          {lens === 'vault' && requests.length > 0 && <RequestsBanner requests={requests} onApprove={approveRequest} />}

          {/* list + detail */}
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {lens === 'vault' && publicOnly && rows.length === 0 && !loading
                ? <PublicShelfEmpty shelfHref={shelfHref} />
                : (lens === 'vault' && loading) || (lens === 'shared' && sharedLoading) ? <LibrarySkeleton />
                : rows.length === 0 ? (
                  <div className="ui-panel">
                    <EmptyState icon={<Icon name={lens === 'shared' ? 'org' : 'folder'} size={18} />}
                      title={lens === 'shared' ? (searching ? `No shared items match “${query}”` : 'Nothing has been shared with you yet')
                        : searching ? `No matches for “${query}” in this vault` : path.length ? 'This folder is empty' : items.length ? `Nothing at the top level — ${items.filter((a) => !a.isFolder).length} item${items.filter((a) => !a.isFolder).length === 1 ? '' : 's'} in folders` : 'Nothing in your vault yet'}
                      hint={lens === 'shared' ? 'A grant someone issues to you appears here as an item you can open.' : searching ? 'Try fewer words, or another folder.' : 'Documents, playbooks, ontologies and records your runs produce, or that you add.'}
                      action={writable && !searching ? <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>Add to vault</Button> : undefined} />
                  </div>
                ) : (
                  <ArtifactList rows={rows} selectedId={selectedId} ownerLabel={ownerLabel} onOpen={select} onDescend={descend}
                    onDelete={lens === 'vault' ? removeItem : undefined} />
                )}
            </div>

            {selected && (
              <DetailPanel
                key={selected.id}
                artifact={selected}
                items={items}
                ownerLabel={ownerLabel}
                ownerVaultKind={ownerVaultKind}
                ownerSa={ownerSa}
                folders={allFolders}
                onClose={() => setSelectedId(null)}
                onGrant={grant}
                onRevoke={revoke}
                onDiscuss={discuss}
                onMove={move}
                onRemove={removeItem}
                onOpenMember={select}
                onOpenLive={openLive}
                onHydrate={hydrate}
                onRequestAccess={requestAccess}
                onPublish={publish}
                onSetVisibility={setVisibility}
                publicHref={agentName ? publicHref : () => null}
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
/**
 * The folder tree. A breadcrumb tells you where you ARE; a tree tells you what EXISTS — which is the
 * difference between navigating a vault you already know and discovering one you do not. Derived
 * from the folder artifacts themselves via the SAME buildTree the destination picker uses, so the
 * navigation tree and the move-target tree can never disagree about what exists.
 */
function FolderTree({ nodes, path, onGo, counts }: {
  nodes: TreeNode[]; path: string[]; onGo: (segs: string[]) => void;
  /** folder path -> number of FILES directly in it (not counting subfolders or their contents). */
  counts: Map<string, number>;
}) {
  const here = path.join('/');
  // Everything on the way to the current folder starts open, so navigating never leaves the tree
  // collapsed around where you just went.
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    path.forEach((_, i) => s.add(path.slice(0, i + 1).join('/')));
    return s;
  });
  useEffect(() => {
    setOpen((prev) => {
      const s = new Set(prev);
      path.forEach((_, i) => s.add(path.slice(0, i + 1).join('/')));
      return s;
    });
  }, [here]);

  const [hover, setHover] = useState<string | null>(null);
  const row = (n: TreeNode, depth: number): ReactNode => {
    const on = n.path === here;
    const expanded = open.has(n.path);
    const hasKids = n.children.length > 0;
    return (
      <div key={n.path}>
        <div role="treeitem" aria-selected={on} aria-expanded={hasKids ? expanded : undefined} tabIndex={0}
          onClick={() => onGo(n.path.split('/'))}
          onMouseEnter={() => setHover(n.path)} onMouseLeave={() => setHover((h) => (h === n.path ? null : h))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGo(n.path.split('/')); } }}
          style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13,
            // Top-level folders sit flush with "All items" (they are its rows, not a level under it); a child steps in.
            padding: '.28rem .5rem', paddingLeft: `${0.5 + (depth - 1) * 0.9}rem`,
            background: on ? 'var(--color-surface-sunken)' : 'transparent',
            color: 'var(--color-text-primary)', fontWeight: on ? 600 : 500 }}>
          <span onClick={(e) => { e.stopPropagation(); if (hasKids) setOpen((s) => { const n2 = new Set(s); n2.has(n.path) ? n2.delete(n.path) : n2.add(n.path); return n2; }); }}
            style={{ width: 12, flexShrink: 0, color: 'var(--color-text-muted)', fontSize: 10, textAlign: 'center' }}
            aria-hidden={!hasKids}>{hasKids ? (expanded ? '▾' : '▸') : ''}</span>
          <Icon name="folder" size={14} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
          <span style={hover === n.path ? { flex: 1, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }} title={depth === 1 && appOfFolder(n.name) ? `${n.name} — written by ${appOfFolder(n.name)}, an app you connected` : n.name}>
            {n.name}
            {depth === 1 && appOfFolder(n.name) && <span style={{ ...mutedText, fontSize: 10, marginLeft: 6 }}>{appOfFolder(n.name)}</span>}
          </span>
          {/* DIRECT files only, deliberately. A subtree total would show 7 on a collapsed parent and
              5 on the child inside it, which reads as double counting; direct counts stay consistent
              however the tree is expanded. A folder holding only subfolders shows nothing, which is
              the honest answer — its contents are the folders already visible beneath it. */}
          {(counts.get(n.path) ?? 0) > 0 && (
            <span style={{ ...mutedText, fontSize: 11, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
              title={`${counts.get(n.path)} file${counts.get(n.path) === 1 ? '' : 's'} directly in this folder`}>
              {counts.get(n.path)}
            </span>
          )}
        </div>
        {hasKids && expanded && n.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  const atRoot = path.length === 0;
  return (
    <div role="tree" aria-label="Folders">
      <div role="treeitem" aria-selected={atRoot} tabIndex={0}
        onClick={() => onGo([])}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGo([]); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13, padding: '.28rem .5rem',
          background: atRoot ? 'var(--color-surface-sunken)' : 'transparent',
          color: 'var(--color-text-primary)', fontWeight: atRoot ? 600 : 500 }}>
        <span style={{ width: 12, flexShrink: 0 }} />
        <Icon name="vault" size={14} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
        <span style={{ flex: 1 }}>All items</span>
        {(counts.get('') ?? 0) > 0 && (
          <span style={{ ...mutedText, fontSize: 11, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
            title={`${counts.get('')} file${counts.get('') === 1 ? '' : 's'} at the vault root`}>{counts.get('')}</span>
        )}
      </div>
      {nodes.map((n) => row(n, 1))}
      {nodes.length === 0 && <p style={{ ...mutedText, fontSize: 12, padding: '.3rem .7rem' }}>No folders yet.</p>}
    </div>
  );
}

/** A path no folder can have (a folder name never holds a slash), so the tree lights nothing while a place outside it is open. */
const NOWHERE = ['/'];

function FolderRail({ lens, onLens, items, path, onGo }: {
  lens: Lens; onLens: (l: Lens) => void; items: Artifact[]; path: string[]; onGo: (segs: string[]) => void;
}) {
  // One pass over the artifacts rather than a scan per node: a vault with many folders would
  // otherwise walk the whole list once for every row it draws.
  const fileCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of items) if (!a.isFolder) m.set(a.folder, (m.get(a.folder) ?? 0) + 1);
    return m;
  }, [items]);
  const heading = (s: string) => (
    <div style={{ ...mutedText, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', padding: '.3rem .7rem' }}>{s}</div>
  );
  const sharedOn = lens === 'shared';
  return (
    <div aria-label="Folders" style={{ ...cardSty, padding: '.4rem 0', width: 'clamp(260px, 24%, 420px)', flexShrink: 0, color: 'var(--color-text-body)' }}>
      {heading('Folders')}
      {/* THE FOLDERS ARE THE NAVIGATION. The vault is a tree; "public" is a property a file or folder carries (a
          filter above the list, a chip on the row), and the workspace switcher in the header already says whose
          vault this is — so there is no scope rail to explain, only the tree and one mounted place beneath it. */}
      <FolderTree nodes={buildTree(items).children} path={sharedOn ? NOWHERE : path} onGo={onGo} counts={fileCounts} />
      <div style={{ borderTop: '1px solid var(--color-border)', margin: '.4rem 0' }} />
      {/* Shared with me: a PLACE, not a folder of yours — what other vaults granted you into, flat, read live from theirs. */}
      <div role="treeitem" aria-selected={sharedOn} tabIndex={0} data-testid="shared-place"
        onClick={() => onLens('shared')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onLens('shared'); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13, padding: '.28rem .5rem',
          background: sharedOn ? 'var(--color-surface-sunken)' : 'transparent', color: 'var(--color-text-primary)', fontWeight: sharedOn ? 600 : 500 }}
        title="What other vaults granted you — read live from theirs, never copied here">
        <span style={{ width: 12, flexShrink: 0 }} />
        <Icon name="shared" size={14} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
        <span style={{ flex: 1 }}>Shared with me</span>
      </div>
    </div>
  );
}

function Breadcrumb({ lens, path, onGo }: { lens: Lens; path: string[]; onGo: (segs: string[]) => void }) {
  if (lens !== 'vault') return <b style={{ fontSize: 14 }}>Shared with me</b>;
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
function ArtifactList({ rows, selectedId, ownerLabel, onOpen, onDescend, onDelete }: {
  rows: Artifact[]; selectedId: string | null; ownerLabel: string; onOpen: (id: string) => void; onDescend: (name: string) => void;
  /** Only passed for the OWNED vault lens — you cannot delete an artifact someone shared with you. */
  onDelete?: (a: Artifact) => void;
}) {
  const cols = onDelete ? '2.2fr 1.1fr .8fr .8fr 1fr .5fr 2rem' : '2.2fr 1.1fr .8fr .8fr 1fr .5fr';
  return (
    <div style={{ ...cardSty, padding: 0, overflow: 'hidden', color: 'var(--color-text-body)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '.5rem', padding: '.5rem .8rem', ...mutedText, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', borderBottom: '1px solid var(--color-border)' }}>
        <span>Name</span><span>Owner</span><span>Access</span><span>Fresh</span><span>Authority</span><span>Ver</span>{onDelete && <span />}
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
            style={{ display: 'grid', gridTemplateColumns: cols, gap: '.5rem', alignItems: 'center', padding: '.55rem .8rem', minHeight: 44, cursor: 'pointer',
              borderBottom: '1px solid var(--color-border)', background: on ? 'var(--color-surface-raised)' : 'transparent', boxShadow: on ? 'inset 3px 0 0 var(--color-amber-500)' : 'none',
              // Explicit, not inherited: an ancestor that sets no colour leaves this at the browser
              // default, which on a light surface reads as white on white.
              color: 'var(--color-text-primary)' }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--color-surface-sunken)'; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minWidth: 0 }}>
              <Icon name={a.isFolder ? 'folder' : KIND_META[a.kind].icon} size={17} style={{ color: 'var(--color-text-muted)' }} />
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
              <span style={{ ...badgeStyle('neutral'), fontSize: 10 }}>{a.isFolder ? (a.id.startsWith('folder:') && a.size ? `Folder · ${a.size}` : 'Folder') : KIND_META[a.kind].label}</span>
              {!a.isFolder && <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(a.id); }} title={`Open ${a.name}`} data-testid={`library-view-${a.id}`} style={{ ...btnSty, padding: '.1rem .5rem', fontSize: 11, flexShrink: 0 }}>View</button>}
              {a.effectiveAccessPolicy === 'public' && <span style={{ ...badgeStyle('ok'), fontSize: 10 }} title={a.accessPolicy === 'public' ? 'Anyone may read this — you made it public' : 'Anyone may read this — a folder above it is public'} data-testid="public-chip">Public</span>}
            </span>
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><b>{owner}</b></span>
            <span><span style={{ ...badgeStyle(ACCESS_TONE[mode]), fontSize: 11 }}>{mode}</span></span>
            <span>{a.isFolder ? <span style={{ ...mutedText, fontSize: 12 }}>—</span> : <span style={{ ...badgeStyle(FRESH_TONE[fresh]), fontSize: 11 }}>{fresh}</span>}</span>
            <span style={{ ...mutedText, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{authority}</span>
            <span style={{ ...mono, ...mutedText, fontSize: 12 }}>{a.isFolder ? '—' : `v${a.version ?? 1}`}</span>
            {onDelete && (
              <button type="button" title={a.isFolder ? 'Delete this folder and everything in it' : 'Delete this file'}
                aria-label={`Delete ${a.name}`}
                onClick={(e) => { e.stopPropagation(); onDelete(a); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, lineHeight: 1,
                  color: 'var(--color-text-muted)', fontSize: 15 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger, #c0392b)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PublicShelfEmpty({ shelfHref }: { shelfHref: string | null }) {
  return (
    <div style={{ ...cardSty, padding: '1.6rem' }} data-testid="public-shelf-empty">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <Icon name="public" size={20} style={{ color: 'var(--color-text-muted)' }} />
        <h3 style={{ margin: 0 }}>Nothing public yet</h3>
      </div>
      <p style={{ ...mutedText, marginTop: '.5rem', maxWidth: 520 }}>
        Your public shelf is what anyone in the world can read of this Library — served by your own agent over A2A, and shown at your Home&apos;s <code>/published</code> page. Open a file or a folder in <b>My vault</b> and choose <b>Make public</b>; a public folder makes everything under it public.
      </p>
      {shelfHref && <p style={{ ...mutedText, marginTop: '.5rem' }}><a href={shelfHref} target="_blank" rel="noreferrer">See your shelf as anyone would ↗</a></p>}
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
function DetailPanel({ artifact, items, ownerLabel, ownerVaultKind, ownerSa, folders, onClose, onGrant, onRevoke, onDiscuss, onMove, onRemove, onOpenMember, onOpenLive, onHydrate, onRequestAccess, onPublish, onSetVisibility, publicHref }: {
  artifact: Artifact; items: Artifact[]; ownerLabel: string; ownerVaultKind: string; ownerSa: string; folders: string[];
  onClose: () => void; onGrant: (id: string, addr: string, kind: string, actions: string[], label?: string) => void; onRevoke: (id: string, addr: string) => void;
  onDiscuss: (id: string) => void; onMove: (a: Artifact, dest: string) => void; onRemove: (a: Artifact) => void; onOpenMember: (id: string) => void;
  onOpenLive: (a: Artifact) => Promise<Artifact>; onHydrate: (a: Artifact) => Promise<Artifact>; onRequestAccess: (a: Artifact, actions: string[]) => Promise<void>;
  onPublish: (id: string) => void;
  onSetVisibility: (id: string, policy: AccessPolicy) => void;
  publicHref: (a: Artifact) => string | null;
}) {
  const [tab, setTab] = useState<Tab>('content');
  const [menuOpen, setMenuOpen] = useState(false);
  const [live, setLive] = useState<Artifact | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // A skill-kind artifact that HAS BYTES is a FILE and must show them. This used to treat every
  // skill as a bundle, from when one entry stood in for a whole directory — so a real SKILL.md
  // rendered a placeholder about directories instead of its own content. Now that packages are
  // stored as actual folders, only a folder is a bundle.
  const isBundle = artifact.isFolder;
  // 398 §6.2 — a skill, a bundle, or a PAGE (md, json-ld) can be published as a signed release; an image or a ttl cannot.
  const publishable = artifact.kind === 'skill' || artifact.kind === 'md' || artifact.kind === 'json-ld' || artifact.isFolder === true;
  const owned = (artifact.accessMode ?? 'Owned') === 'Owned';
  const members = useMemo(() => (artifact.isFolder ? items.filter((x) => x.folder === fullPath(artifact)) : []), [artifact, items]);

  const openLive = async () => { setLiveErr(null); setOpening(true); try { setLive(await onOpenLive(artifact)); setTab('content'); } catch (e) { setLiveErr((e as Error).message); } finally { setOpening(false); } };

  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  const id = artifactIdentity(artifact, { sa: ownerSa, vaultLabel: ownerVaultKind }, publishable);
  const mode: AccessMode = artifact.accessMode ?? 'Owned';
  return (
    <Drawer wide
      title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}><Icon name={artifact.isFolder ? 'folder' : KIND_META[artifact.kind].icon} size={18} style={{ color: 'var(--color-text-muted)' }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.name}</span></span>}
      onClose={onClose}
      actions={<Button variant="primary" size="sm" disabled={opening} onClick={() => (owned ? setTab('access') : void openLive())}>{owned ? 'Manage access' : opening ? 'Opening…' : 'Open live'}</Button>}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
        <Chip>{artifact.isFolder ? 'Folder' : KIND_META[artifact.kind].label}</Chip>
        <Chip>v{artifact.version ?? 1}{id.latestRelease ? ` · released ${id.latestRelease.version}` : ''}</Chip>
        <Chip tone={ACCESS_TONE[mode] === 'ok' ? 'ok' : ACCESS_TONE[mode] === 'warn' ? 'warn' : undefined}>{mode}</Chip>
        {!artifact.isFolder && <Chip tone={FRESH_TONE[mode !== 'Owned' ? 'Cached' : freshnessOf(artifact)] === 'ok' ? 'ok' : undefined}>{mode !== 'Owned' ? 'Cached' : freshnessOf(artifact)}</Chip>}
        {!owned && artifact.sharedBy && <Meta>shared by {shortAddr(artifact.sharedBy)}</Meta>}
        <span style={{ flex: 1 }} />
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
      </div>

      {/* spec 398 §6.2 — ARTIFACT IDENTITY: version · author · sources · scope · linked work item · access method; and the
          three acts kept distinct (share on Access, publish on Provenance, replicate not yet). Absent is said absent. */}
      {(() => {
        return (
          <div data-testid="artifact-identity" data-access={id.accessMethod} className="ui-card ui-card--quiet" style={{ padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
            <KeyValue rows={[
              ['Author', shortAddr(id.author)],
              ['Sources', id.sources.length ? id.sources.map((x) => `${x.kind}: ${x.value.length > 28 ? `${x.value.slice(0, 25)}…` : x.value}`).join(' · ') : 'none recorded', { absent: !id.sources.length }],
              ['Scope', `${id.scope.vault} · ${id.scope.live} live grant${id.scope.live === 1 ? '' : 's'}${id.scope.grants > id.scope.live ? ` (${id.scope.grants - id.scope.live} revoked)` : ''}`],
              ['Work item', 'none linked yet', { absent: true }],
              ['Access', <strong key="a">{id.accessMethod}</strong>],
            ]} />
            <div style={{ display: 'flex', gap: 6, marginTop: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Micro>Acts</Micro>
              <Button size="sm" disabled={id.acts.share !== 'offered'} onClick={() => setTab('access')} title="Share = a grant on this artifact; a preview shared never grants vault or sandbox access">Share</Button>
              <Button size="sm" disabled={id.acts.publish !== 'offered'} onClick={() => { onPublish(artifact.id); setTab('provenance'); }} title={id.acts.publish === 'not-publishable' ? 'only a playbook or a folder is published as a release' : 'Publish = a signed release under your name'}>Publish</Button>
              <Button size="sm" disabled title="Replicate = an authorized copy in another vault — not yet an act here (398 §6.2)">Replicate</Button>
              <Meta>replicate is not an act here yet</Meta>
            </div>
            {/* Spec 412 — PUBLIC is a fourth word, kept apart from the three acts: who may read, decided on the record.
                A folder made public makes everything under it public; a declaration on the entry itself wins. */}
            {owned && (() => {
              const eff = artifact.effectiveAccessPolicy ?? 'private';
              const inherited = eff === 'public' && artifact.accessPolicy !== 'public';
              const href = eff === 'public' ? publicHref(artifact) : null;
              return (
                <div data-testid="artifact-visibility" data-policy={eff} style={{ display: 'flex', gap: 6, marginTop: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Micro>Who may read</Micro>
                  <Chip tone={eff === 'public' ? 'ok' : undefined}>{eff === 'public' ? (inherited ? 'Public · from its folder' : 'Public') : 'Private'}</Chip>
                  {eff === 'public'
                    ? <Button size="sm" onClick={() => onSetVisibility(artifact.id, 'private')} title={inherited ? 'Declare this one private even though its folder is public' : 'Only you and those you shared it with'}>Make private</Button>
                    : <Button size="sm" onClick={() => onSetVisibility(artifact.id, 'public')} title={artifact.isFolder ? 'Anyone may read everything in this folder, served by your agent' : 'Anyone may read this, served by your agent'}>Make public</Button>}
                  {href && <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>read it as anyone would ↗</a>}
                  {eff === 'public' && !artifact.isFolder && !href && <Meta>served on this agent&apos;s public shelf (A2A)</Meta>}
                </div>
              );
            })()}
          </div>
        );
      })()}

      <div style={{ marginBottom: 'var(--sp-3)' }}>
        <Tabs value={tab} onChange={setTab} label="Artifact" items={[{ id: 'content' as Tab, label: artifact.isFolder ? 'Contents' : 'Content' }, { id: 'access' as Tab, label: 'Access' }, { id: 'provenance' as Tab, label: 'Provenance' }, { id: 'versions' as Tab, label: 'Versions' }]} />
      </div>

      <div>
        {tab === 'content' && (isBundle
          ? <Members artifact={artifact} members={members} onOpenMember={onOpenMember} />
          : owned ? <ContentPreview artifact={artifact} items={items} onHydrate={onHydrate} />
          : <SharedContent artifact={live ?? artifact} hasLive={!!live} opening={opening} liveErr={liveErr} onOpenLive={openLive} />)}
        {tab === 'access' && (owned
          ? <AccessTab artifact={artifact} onGrant={onGrant} onRevoke={onRevoke} />
          : <SharedAccess artifact={artifact} onRequestAccess={onRequestAccess} />)}
        {tab === 'provenance' && <ProvenanceTab artifact={artifact} ownerLabel={owned ? ownerLabel : (artifact.sharedBy ? shortAddr(artifact.sharedBy) : 'Another vault')} ownerVaultKind={owned ? ownerVaultKind : `${artifact.sharedByKind ?? 'Person'} vault`} publishable={publishable} owned={owned} onPublish={() => onPublish(artifact.id)} />}
        {tab === 'versions' && <VersionsTab version={artifact.version ?? 1} />}
      </div>
    </Drawer>
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

function ContentPreview({ artifact: listed, items, onHydrate }: { artifact: Artifact; items: Artifact[]; onHydrate?: (a: Artifact) => Promise<Artifact> }) {
  // The listing may carry no bytes (an organization's catalog is an index): read the document when the panel opens.
  const [hydrated, setHydrated] = useState<Artifact | null>(null);
  const [reading, setReading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const needsBody = !listed.bytesB64 && !listed.pointer && (listed.source === 'blob' || listed.source === 'vault');
  useEffect(() => {
    setHydrated(null); setReadErr(null);
    if (!needsBody || !onHydrate) return;
    let live = true;
    setReading(true);
    onHydrate(listed).then((a) => { if (live) setHydrated(a); }).catch((e: unknown) => { if (live) setReadErr(e instanceof Error ? e.message : String(e)); }).finally(() => { if (live) setReading(false); });
    return () => { live = false; };
  }, [listed, needsBody, onHydrate]);
  const artifact = hydrated ?? listed;
  if (needsBody && reading) return <p style={{ ...mutedText, fontSize: 13 }} data-testid="library-reading">Reading {listed.name} from the vault…</p>;
  if (needsBody && readErr) return <p style={{ ...errorText, fontSize: 13 }} data-testid="library-read-failed">{readErr}</p>;
  if (artifact.source !== 'blob' || !artifact.bytesB64) {
    return (
      <div>
        <p style={{ ...mutedText, fontSize: 13 }}>This artifact&apos;s bytes live in <b>{artifact.source}</b>{artifact.pointer ? <> at <span style={mono}>{artifact.pointer}</span></> : null}. Opening it live streams from the owning vault via MCP.</p>
        <p style={{ ...mutedText, fontSize: 12, marginTop: '.4rem' }}>Live MCP read arrives in Phase 3 (the two-vault read path).</p>
      </div>
    );
  }
  // UTF-8 safe: atob alone is latin-1, so an em dash in a SKILL.md renders as mojibake.
  let text = '';
  try { text = new TextDecoder().decode(Uint8Array.from(atob(artifact.bytesB64), (c) => c.charCodeAt(0))); } catch { text = ''; }
  if (artifact.kind === 'image') return <img alt={artifact.name} src={`data:${artifact.contentType};base64,${artifact.bytesB64}`} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--color-border)' }} />;

  const isMd = artifact.kind === 'skill' || artifact.kind === 'md' || artifact.name.toLowerCase().endsWith('.md');
  const pretty = artifact.kind === 'json-ld' ? (() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })() : text;
  return <PreviewBody artifact={artifact} items={items} text={text} pretty={pretty} isMd={isMd} />;
}

const preSty: CSSProperties = { ...mono, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 380, overflow: 'auto', background: 'var(--color-surface-sunken)', padding: '.6rem', borderRadius: 6, color: 'var(--color-text-primary)' };

function PreviewBody({ artifact, items, text, pretty, isMd }: { artifact: Artifact; items: Artifact[]; text: string; pretty: string; isMd: boolean }) {
  const [raw, setRaw] = useState(false);
  const fm = isMd ? splitFrontmatter(text) : null;
  return (
    <div>
      {isMd && (
        <div style={{ display: 'flex', gap: 4, marginBottom: '.5rem' }}>
          <button style={segSty(!raw)} onClick={() => setRaw(false)}>Formatted</button>
          <button style={segSty(raw)} onClick={() => setRaw(true)}>Raw</button>
        </div>
      )}
      {isMd && !raw ? (
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          {fm && fm.entries.length > 0 && (
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '.5rem .6rem', marginBottom: '.7rem', background: 'var(--color-surface-sunken)' }}>
              {fm.entries.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: '.5rem', fontSize: 12, padding: '.1rem 0' }}>
                  <span style={{ ...mutedText, minWidth: 92, flexShrink: 0 }}>{k}</span>
                  <span style={{ color: 'var(--color-text-primary)', minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <Markdown source={fm ? fm.body : text} artifact={artifact} items={items} />
        </div>
      ) : (
        <pre style={preSty}>{pretty}</pre>
      )}
      {artifact.kind === 'skill' && (
        <p style={{ ...mutedText, fontSize: 12, marginTop: '.6rem' }}>
          A skill is a <b>directory</b> — this SKILL.md plus the queries, code, schemas and media that realize it. Its siblings sit alongside it in this folder.
        </p>
      )}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: '.5rem', ...badgeStyle('ok'), fontSize: 11 }}><Icon name="check" size={12} />Content commitment verified</div>
    </div>
  );
}

/** YAML frontmatter, shown as fields rather than buried at the top of the prose. Flat scalars only —
 *  anything structured stays in the raw view rather than being half-parsed here. */
function splitFrontmatter(src: string): { entries: [string, string][]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { entries: [], body: src };
  const entries: [string, string][] = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) entries.push([kv[1]!, kv[2]!.replace(/^["']|["']$/g, '')]);
  }
  return { entries, body: m[2] ?? '' };
}

/**
 * Markdown via react-markdown + remark-gfm — the same pair the skills app already standardised on,
 * rather than a second hand-rolled renderer that would drift from it. react-markdown builds React
 * elements and does NOT render raw HTML unless rehype-raw is added, which it deliberately is not:
 * these bytes are the owner's file today and another vault's shared artifact tomorrow.
 *
 * Two behaviours are specific to a VAULT preview, and are why this is not a bare <ReactMarkdown/>:
 * images resolve against sibling artifacts, and mermaid fences render as diagrams.
 */
function Markdown({ source, artifact, items }: { source: string; artifact: Artifact; items: Artifact[] }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-text-body)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <div style={{ fontWeight: 800, fontSize: 17, margin: '.7rem 0 .3rem', color: 'var(--color-text-primary)' }}>{children}</div>,
          h2: ({ children }) => <div style={{ fontWeight: 800, fontSize: 15, margin: '.7rem 0 .3rem', color: 'var(--color-text-primary)' }}>{children}</div>,
          h3: ({ children }) => <div style={{ fontWeight: 700, fontSize: 13.5, margin: '.6rem 0 .25rem', color: 'var(--color-text-primary)' }}>{children}</div>,
          p: ({ children }) => <p style={{ margin: '.35rem 0' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '.3rem 0 .3rem 1.1rem' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '.3rem 0 .3rem 1.1rem' }}>{children}</ol>,
          blockquote: ({ children }) => <div style={{ borderLeft: '3px solid var(--color-border-strong)', paddingLeft: '.6rem', ...mutedText, margin: '.4rem 0' }}>{children}</div>,
          hr: () => <hr style={{ border: 0, borderTop: '1px solid var(--color-border)', margin: '.7rem 0' }} />,
          table: ({ children }) => <div style={{ overflowX: 'auto', margin: '.4rem 0' }}><table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>{children}</table></div>,
          th: ({ children }) => <th style={{ textAlign: 'left', padding: '.25rem .45rem', borderBottom: '1px solid var(--color-border)', ...mutedText }}>{children}</th>,
          td: ({ children }) => <td style={{ padding: '.25rem .45rem', borderBottom: '1px solid var(--color-border)', verticalAlign: 'top' }}>{children}</td>,
          a: ({ href, children }) => (/^https?:\/\//i.test(href ?? '')
            ? <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--color-amber-700)' }}>{children}</a>
            : <span>{children}</span>),
          img: ({ src, alt }) => <VaultImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} artifact={artifact} items={items} />,
          code: ({ className, children }) => {
            const body = String(children ?? '').replace(/\n$/, '');
            if (/language-mermaid/.test(className ?? '')) return <MermaidDiagram chart={body} />;
            return /language-/.test(className ?? '') || body.includes('\n')
              ? <pre style={{ ...preSty, maxHeight: 300 }}>{body}</pre>
              : <code style={{ ...mono, fontSize: 12, background: 'var(--color-surface-sunken)', padding: '0 .25rem', borderRadius: 3 }}>{body}</code>;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >{source}</ReactMarkdown>
    </div>
  );
}

/**
 * An image in a vault document usually points at a SIBLING (`assets/logo.png`), which no browser can
 * fetch — the bytes are in a vault, not on a path. Relative sources resolve against the other
 * artifacts in this package and render from their stored bytes; remote http(s) is left alone.
 */
function VaultImage({ src, alt, artifact, items }: { src: string; alt: string; artifact: Artifact; items: Artifact[] }) {
  if (/^(https?:|data:)/i.test(src)) {
    return <img alt={alt} src={src} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--color-border)' }} />;
  }
  const segs = src.replace(/^\.\//, '').split('/');
  const name = segs[segs.length - 1]!;
  const folder = [artifact.folder, ...segs.slice(0, -1)].filter(Boolean).join('/');
  const hit = items.find((a) => !a.isFolder && a.name === name && a.folder === folder)
    ?? items.find((a) => !a.isFolder && a.name === name && (a.folder === artifact.folder || a.folder.startsWith(`${artifact.folder}/`)));
  if (!hit?.bytesB64) {
    return (
      <span style={{ ...mutedText, fontSize: 12, display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px dashed var(--color-border-strong)', borderRadius: 6, padding: '.3rem .5rem' }}>
        <Icon name="image" size={13} />{alt || name} — not in this package
      </span>
    );
  }
  return <img alt={alt || name} src={`data:${hit.contentType || 'image/png'};base64,${hit.bytesB64}`} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--color-border)' }} />;
}

/**
 * Mermaid, imported LAZILY. The library is well over a megabyte, and a vault preview must not pay
 * for it on every document that contains no diagram — the import fires only when a mermaid fence is
 * actually rendered.
 */
function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const { svg: out } = await mermaid.render(idRef.current, chart);
        if (live) { setSvg(out); setErr(null); }
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { live = false; };
  }, [chart]);

  // A diagram that will not parse falls back to its SOURCE rather than vanishing: the text is what
  // the author wrote, and losing content to a rendering failure is worse than an unstyled block.
  if (err) {
    return (
      <div>
        <p style={{ ...mutedText, fontSize: 12 }}>Mermaid diagram could not be rendered ({err}). Showing the source:</p>
        <pre style={{ ...preSty, maxHeight: 260 }}>{chart}</pre>
      </div>
    );
  }
  if (!svg) return <p style={{ ...mutedText, fontSize: 12 }}>rendering diagram…</p>;
  // The only markup injected anywhere in this preview, and it is MERMAID'S OWN OUTPUT rather than
  // the document's bytes — rendered under securityLevel 'strict', which disables HTML labels.
  return <div style={{ margin: '.5rem 0', overflowX: 'auto' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Members({ artifact, members, onOpenMember }: { artifact: Artifact; members: Artifact[]; onOpenMember: (id: string) => void }) {
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
              style={{ ...cardSty, textAlign: 'center', padding: '1.4rem', border: `2px dashed ${drag ? 'var(--color-amber-500)' : 'var(--color-border-strong)'}`, background: drag ? 'var(--color-amber-50)' : 'var(--color-surface)' }}>
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

// `color: undefined` REMOVES the property rather than falling back to the spread btnSty value, so
// the unselected segments had no colour at all and rendered in the browser's default button text —
// invisible on our light surface. Every branch names a token; none is left to inherit or default.
const segSty = (on: boolean): CSSProperties => ({
  ...btnSty,
  border: 0, minHeight: 0, padding: '5px 10px', borderRadius: 6, fontSize: '12.5px',
  background: on ? 'var(--color-surface)' : 'transparent',
  color: on ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
  boxShadow: on ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
});
