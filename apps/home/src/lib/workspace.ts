// Workspace URL scope (spec 315, ported from the impact home's IA). The address bar carries the
// active context so deep links, refresh, and back-button land in the right authority scope —
// never a hidden session flag. Workspaces are the CUSTODIAL smart agents only, grouped by the
// ADR-0046 classification: PERSON (you), ORGANIZATION, SERVICE (treasury is a service ROLE, not
// a class — every service-class agent shares the `/service/<address>` workspace). Connected apps
// are external grants with no custody and stay in the person nav (/apps), never in the switcher.
// ORG workspaces live under `/org/<address>/<page>`; the PERSON workspace is the clean flat
// routes (flat == you).
//
// A PERSONA is the fourth (spec: persona.ttl) — a SECOND PERSON AGENT OF THE SAME HUMAN, a trail name or a
// part in a play. It is person-CLASS, so it wants the person's own surfaces, and it is not you, so it cannot
// have the flat routes: it lives under `/as/<address>/<page>`, which is the preposition the switcher uses.
// Flat still means you, and exactly one agent is ever you.

export type WorkspaceScope =
  | { kind: 'person' }
  | { kind: 'persona'; agent: string }
  | { kind: 'org'; org: string }
  | { kind: 'service'; agent: string };

/** Derive the active workspace from the pathname. */
export function parseWorkspacePath(pathname: string): WorkspaceScope {
  const org = pathname.match(/^\/org\/([^/]+)(?:\/|$)/);
  if (org?.[1]) return { kind: 'org', org: decodeURIComponent(org[1]) };
  const s = pathname.match(/^\/service\/([^/]+)(?:\/|$)/);
  if (s?.[1]) return { kind: 'service', agent: decodeURIComponent(s[1]) };
  const as = pathname.match(/^\/as\/([^/]+)(?:\/|$)/);
  if (as?.[1]) return { kind: 'persona', agent: decodeURIComponent(as[1]) };
  return { kind: 'person' };
}

/** Canonical URL for a page within an org workspace. */
export function orgHref(org: string, page: string): string {
  return `/org/${encodeURIComponent(org)}/${page}`;
}

/** A persona's workspace page — another name of your own, acting as itself. */
export function personaHref(agent: string, page?: string): string {
  const base = `/as/${encodeURIComponent(agent)}`;
  return page ? `${base}/${page}` : base;
}

/** A service-class agent's workspace page (role-agnostic — ADR-0046). */
export function serviceHref(agent: string, page?: string): string {
  const base = `/service/${encodeURIComponent(agent)}`;
  return page ? `${base}/${page}` : base;
}

/** spec 348 — a page in the ACTIVE workspace, whichever class it is. The person's workspace is the
 *  portal root, so their pages are top-level; an org's and a service's carry the SA. One helper, so a
 *  nav item is written once and not three times with a class branch around it. */
export function workspaceHref(active: WorkspaceScope, page: string): string {
  if (active.kind === 'org') return orgHref(active.org, page);
  if (active.kind === 'service') return serviceHref(active.agent, page);
  if (active.kind === 'persona') return personaHref(active.agent, page);
  return `/${page}`;
}

/**
 * WHICH AGENT IS THIS SCOPE ABOUT — the one question every scoped view actually asks, in one place.
 *
 * Every consumer used to spell it as `org ? … : service ? … : self`, which reads as a complete answer and is
 * really a two-name allow-list with a fallback. Adding a PERSONA silently fell through to `self`, so a page
 * whose URL said one agent would have read the connected person's vault — the same data under two names,
 * which is the one mistake an identity model must not make. Written once, it cannot drift again.
 */
export function workspaceAgent(active: WorkspaceScope, self: string): string {
  if (active.kind === 'org') return active.org.toLowerCase();
  if (active.kind === 'service') return active.agent.toLowerCase();
  if (active.kind === 'persona') return active.agent.toLowerCase();
  return self.toLowerCase();
}

/** Is this workspace the connected person THEMSELVES? A persona is person-class but is never you. */
export function isSelfScope(active: WorkspaceScope): boolean {
  return active.kind === 'person';
}

/** Person-CLASS: you or one of your other names. Decides which surfaces a workspace offers (ADR-0046). */
export function isPersonClassScope(active: WorkspaceScope): boolean {
  return active.kind === 'person' || active.kind === 'persona';
}
