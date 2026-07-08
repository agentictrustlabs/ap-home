// Workspace URL scope (spec 315, ported from the impact home's IA). The address bar carries the
// active context so deep links, refresh, and back-button land in the right authority scope —
// never a hidden session flag. Workspaces are the CUSTODIAL smart agents only (person, org,
// treasury — agents the connected custodian controls). Connected apps are external grants with
// no custody and stay in the person nav (/apps), never in the switcher. ORG workspaces live
// under `/org/<address>/<page>`, TREASURY workspaces under `/treasury/<address>`; the PERSON
// workspace is the clean flat routes (flat == you).

export type WorkspaceScope =
  | { kind: 'person' }
  | { kind: 'org'; org: string }
  | { kind: 'treasury'; agent: string };

/** Derive the active workspace from the pathname. (`/treasuries` — plural — stays person-scoped.) */
export function parseWorkspacePath(pathname: string): WorkspaceScope {
  const org = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
  if (org?.[1]) return { kind: 'org', org: decodeURIComponent(org[1]) };
  const t = pathname.match(/^\/treasury\/([^/]+)(?:\/|$)/);
  if (t?.[1]) return { kind: 'treasury', agent: decodeURIComponent(t[1]) };
  return { kind: 'person' };
}

/** Canonical URL for a page within an org workspace. */
export function orgHref(org: string, page: string): string {
  return `/org/${encodeURIComponent(org)}/${page}`;
}

/** A treasury workspace's landing page. */
export function treasuryHref(agent: string): string {
  return `/treasury/${encodeURIComponent(agent)}`;
}
