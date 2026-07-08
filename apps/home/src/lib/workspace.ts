// Workspace URL scope (spec 315, ported from the impact home's IA). The address bar carries the
// active context so deep links, refresh, and back-button land in the right authority scope —
// never a hidden session flag. Workspaces are the CUSTODIAL smart agents only, grouped by the
// ADR-0046 classification: PERSON (you), ORGANIZATION, SERVICE (treasury is a service ROLE, not
// a class — every service-class agent shares the `/service/<address>` workspace). Connected apps
// are external grants with no custody and stay in the person nav (/apps), never in the switcher.
// ORG workspaces live under `/org/<address>/<page>`; the PERSON workspace is the clean flat
// routes (flat == you).

export type WorkspaceScope =
  | { kind: 'person' }
  | { kind: 'org'; org: string }
  | { kind: 'service'; agent: string };

/** Derive the active workspace from the pathname. */
export function parseWorkspacePath(pathname: string): WorkspaceScope {
  const org = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
  if (org?.[1]) return { kind: 'org', org: decodeURIComponent(org[1]) };
  const s = pathname.match(/^\/service\/([^/]+)(?:\/|$)/);
  if (s?.[1]) return { kind: 'service', agent: decodeURIComponent(s[1]) };
  return { kind: 'person' };
}

/** Canonical URL for a page within an org workspace. */
export function orgHref(org: string, page: string): string {
  return `/org/${encodeURIComponent(org)}/${page}`;
}

/** A service-class agent's workspace landing page (role-agnostic — ADR-0046). */
export function serviceHref(agent: string): string {
  return `/service/${encodeURIComponent(agent)}`;
}
