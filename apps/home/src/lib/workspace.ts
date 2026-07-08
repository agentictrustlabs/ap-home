// Workspace URL scope (spec 315, ported from the impact home's IA). The address bar carries the
// active context so deep links, refresh, and back-button land in the right authority scope —
// never a hidden session flag. ORG workspaces live under `/org/<address>/<page>`, APP workspaces
// under `/app/<clientId>`; the PERSON workspace is the clean flat routes (flat == you).

export type WorkspaceScope =
  | { kind: 'person' }
  | { kind: 'org'; org: string }
  | { kind: 'app'; clientId: string };

/** Derive the active workspace from the pathname. */
export function parseWorkspacePath(pathname: string): WorkspaceScope {
  const org = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
  if (org?.[1]) return { kind: 'org', org: decodeURIComponent(org[1]) };
  const app = pathname.match(/^\/app\/([^/]+)(?:\/|$)/);
  if (app?.[1]) return { kind: 'app', clientId: decodeURIComponent(app[1]) };
  return { kind: 'person' };
}

/** Canonical URL for a page within an org workspace. */
export function orgHref(org: string, page: string): string {
  return `/org/${encodeURIComponent(org)}/${page}`;
}

/** An app workspace's landing page. */
export function appHref(clientId: string): string {
  return `/app/${encodeURIComponent(clientId)}`;
}
