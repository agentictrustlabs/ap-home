/**
 * App Workspaces — a named listing of membership organizations an app supports
 * for invite / register (distinct from person/org/service URL scope in workspace.ts).
 *
 * Gather27 is the first: hosts who redeem an invite and register land on this listing.
 */

export interface AppWorkspace {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly blurb: string;
  readonly appHref: string;
  readonly listingHref: string;
}

export const APP_WORKSPACES: readonly AppWorkspace[] = [
  {
    id: 'gather27',
    name: 'Gather27',
    clientId: 'gather-app',
    blurb: 'Membership organizations that host a gathering. Invite → Home connect → host org → event in that org’s vault.',
    appHref: 'https://gather27-web.richardpedersen3.workers.dev/',
    listingHref: 'https://gather27-a2a-production.richardpedersen3.workers.dev',
  },
];

export function workspaceById(id: string): AppWorkspace | undefined {
  return APP_WORKSPACES.find((w) => w.id === id);
}
