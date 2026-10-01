// ARTIFACT IDENTITY — spec 398 §6.2 (APUX-038). Every artifact shows: exact version · author (an SA) · sources · scope
// (which vault, which grants) · linked work item · access method — one of the four the review names: OWNED LOCALLY ·
// LIVE REMOTE · AUTHORIZED REPLICA · DERIVED COPY (mapped from the Library's access mode and source; 338 publications,
// 316 delivery tiers). Share, publish and replicate are three distinct acts: sharing a preview never grants vault or
// sandbox access. Pure; absent is said absent.
export type AccessMethod = 'owned locally' | 'live remote' | 'authorized replica' | 'derived copy';

export interface ArtifactLike {
  id: string; name: string; version?: number; source: 'blob' | 'graphdb' | 'vault' | 'external'; pointer?: string; discussionId?: string;
  contentCommitment?: string; createdAt: number; grants?: Array<{ grantee: { address: string; label?: string }; revoked?: boolean }>; effectiveGrants?: unknown[];
  /** The registry edition this copy was written from (the server's `registry`), beside the vault's own save count. */
  registry?: { id: string; version: string | number };
  releases?: Array<{ version: string; publisher: string; publishedAt: number }>; accessMode?: 'Owned' | 'Read-through' | 'Replica' | 'Public' | 'Projection'; sharedBy?: string;
}

export interface ArtifactIdentity {
  version: string;
  /** The SA that authored it — the vault's owner for an owned artifact; the sharer for a shared one. */
  author: string;
  sources: Array<{ kind: 'pointer' | 'topic' | 'commitment' | 'registry'; value: string }>;
  /** The registry edition this copy was written from, beside the vault's own save count. */
  registryEdition?: { id: string; version: string };
  scope: { vault: string; grants: number; live: number };
  /** No artifact carries its work item yet (398 §4.3) — said absent. */
  linkedWorkItem: null;
  accessMethod: AccessMethod;
  /** The three acts, each with whether THIS surface offers it. */
  acts: { share: 'offered' | 'not-owner'; publish: 'offered' | 'not-publishable' | 'not-owner'; replicate: 'not-yet' };
  latestRelease?: { version: string; publisher: string; at: number };
}

export function accessMethodOf(a: Pick<ArtifactLike, 'source' | 'accessMode'>): AccessMethod {
  const mode = a.accessMode ?? 'Owned';
  if (mode === 'Replica') return 'authorized replica';
  if (mode === 'Public' || mode === 'Projection') return 'derived copy';
  if (mode === 'Read-through') return 'live remote';
  return a.source === 'external' ? 'live remote' : 'owned locally';
}

export function artifactIdentity(a: ArtifactLike, owner: { sa: string; vaultLabel: string }, publishable: boolean): ArtifactIdentity {
  const owned = (a.accessMode ?? 'Owned') === 'Owned';
  const grants = a.grants ?? [];
  const latest = [...(a.releases ?? [])].sort((x, y) => y.publishedAt - x.publishedAt)[0];
  return {
    version: `v${a.version ?? 1}`,
    author: owned ? owner.sa : (a.sharedBy ?? owner.sa),
    sources: [
      ...(a.pointer ? [{ kind: 'pointer' as const, value: a.pointer }] : []),
      ...(a.discussionId ? [{ kind: 'topic' as const, value: a.discussionId }] : []),
      ...(a.contentCommitment ? [{ kind: 'commitment' as const, value: a.contentCommitment }] : []),
      ...(a.registry ? [{ kind: 'registry' as const, value: `${a.registry.id} v${a.registry.version}` }] : []),
    ],
    ...(a.registry ? { registryEdition: { id: a.registry.id, version: String(a.registry.version) } } : {}),
    scope: { vault: owner.vaultLabel, grants: grants.length, live: grants.filter((g) => !g.revoked).length },
    linkedWorkItem: null,
    accessMethod: accessMethodOf(a),
    acts: { share: owned ? 'offered' : 'not-owner', publish: !owned ? 'not-owner' : publishable ? 'offered' : 'not-publishable', replicate: 'not-yet' },
    ...(latest ? { latestRelease: { version: latest.version, publisher: latest.publisher, at: latest.publishedAt } } : {}),
  };
}
