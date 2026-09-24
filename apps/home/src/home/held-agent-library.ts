// The Library of an agent you HOLD — a service, a persona, a workspace agent (ADR-0046) — read the way its
// Records page reads it: from the AGENT'S OWN vault, over your stewardship delegation (agent → you).
//
// WHY NOT `/connect/library?org=<agent>`. That route's org branch reaches the agent's InteractionsDO and reads
// the catalog with the DO-held DELIVERY grant, after verifying an org-shaped stewardship wire. An agent another
// app provisioned — a publishing service that writes its own `content.catalog` + `content.artifact.<id>` through
// its own tools — carries neither, and the org branch answered "nothing here" while Records, reading the same
// vault over the stewardship delegation, listed every record (seen live 2026-09-23 on `gc-test-org.svc`). The
// Records page is the proof the data exists; the Library now reads it the same way, over the same wire.
//
// READ ONLY. The delegation already authorizes writes (`vaultWriteWithDelegation`), but managing another agent's
// catalog from Home is a separate decision; this module only reads. The two record types are the Library's data
// model (ADR-0055): `content.catalog` is the index (folders included), `content.artifact.<id>` the addressable body.
import type { DelegationWire } from '../lib/delegation';

/** One catalog entry as the Library renders it — the shape `server/connect/library.ts` and the agent's own
 *  `library.file.save` both write (`LibraryArtifact` / `LibraryEntry`). */
export interface HeldLibraryEntry {
  id: string;
  kind: 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
  name: string;
  source: 'blob' | 'graphdb' | 'vault' | 'external';
  folder: string;
  isFolder?: boolean;
  pointer?: string;
  contentType: string;
  bytesB64?: string;
  size: number;
  createdAt: number;
  version?: number;
  contentCommitment?: string;
  accessPolicy?: 'public' | 'private';
  grants: unknown[];
  releases?: unknown[];
}

/** Reads one record from the delegator's vault — `vaultReadWithDelegation`, injectable for tests. */
export type DelegatedRecordReader = (d: DelegationWire, recordType: string) => Promise<unknown>;

const KINDS = new Set(['skill', 'ttl', 'md', 'json-ld', 'image']);
const SOURCES = new Set(['blob', 'graphdb', 'vault', 'external']);

function defaultMime(kind: HeldLibraryEntry['kind']): string {
  return kind === 'ttl' ? 'text/turtle' : kind === 'json-ld' ? 'application/ld+json' : kind === 'image' ? 'image/png' : 'text/markdown';
}

/** One raw catalog entry → the render shape, or null when it is not an entry at all (no id / name). Fields the
 *  writer left out take the same defaults the Home's own `upsert` would have written; nothing is invented. */
export function normalizeCatalogEntry(raw: unknown): HeldLibraryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id || typeof e.name !== 'string' || !e.name) return null;
  const kind = (KINDS.has(String(e.kind)) ? e.kind : 'md') as HeldLibraryEntry['kind'];
  const isFolder = e.isFolder === true;
  const bytesB64 = typeof e.bytesB64 === 'string' && e.bytesB64 ? e.bytesB64 : undefined;
  const commitment = typeof e.contentCommitment === 'string' ? e.contentCommitment : typeof e.commitment === 'string' ? e.commitment : undefined;
  return {
    id: e.id,
    kind,
    name: e.name,
    source: (SOURCES.has(String(e.source)) ? e.source : 'blob') as HeldLibraryEntry['source'],
    folder: typeof e.folder === 'string' ? e.folder.replace(/^\/+|\/+$/g, '') : '',
    ...(isFolder ? { isFolder: true } : {}),
    ...(typeof e.pointer === 'string' ? { pointer: e.pointer } : {}),
    contentType: typeof e.contentType === 'string' && e.contentType ? e.contentType : isFolder ? 'inode/directory' : defaultMime(kind),
    ...(bytesB64 ? { bytesB64 } : {}),
    size: typeof e.size === 'number' ? e.size : bytesB64 ? bytesB64.length : 0,
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
    ...(typeof e.version === 'number' ? { version: e.version } : {}),
    ...(commitment ? { contentCommitment: commitment } : {}),
    ...(e.accessPolicy === 'public' || e.accessPolicy === 'private' ? { accessPolicy: e.accessPolicy } : {}),
    grants: Array.isArray(e.grants) ? e.grants : [],
    ...(Array.isArray(e.releases) ? { releases: e.releases } : {}),
  };
}

/**
 * The held agent's catalog, read over its stewardship delegation. An ABSENT catalog is an empty Library (the
 * agent has written none); a catalog that is not a list is SAID, never rendered as empty (ADR-0013).
 */
export async function readHeldAgentCatalog(d: DelegationWire, read: DelegatedRecordReader): Promise<HeldLibraryEntry[]> {
  const raw = await read(d, 'content.catalog');
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('this agent’s content.catalog is not a list — the Library cannot read it');
  return raw.map(normalizeCatalogEntry).filter((e): e is HeldLibraryEntry => e !== null);
}

/**
 * A document's body from its own `content.artifact.<id>` record, for a catalog entry that carries none. Null when
 * the record is absent or has no body.
 */
export async function readHeldAgentArtifactBody(d: DelegationWire, id: string, read: DelegatedRecordReader): Promise<{ bytesB64: string; contentType?: string } | null> {
  const raw = await read(d, `content.artifact.${id}`);
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.bytesB64 !== 'string' || !r.bytesB64) return null;
  return { bytesB64: r.bytesB64, ...(typeof r.contentType === 'string' && r.contentType ? { contentType: r.contentType } : {}) };
}
