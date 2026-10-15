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

// Gather27's addresses come from the deployment (the same variables the gather-app client reads);
// the workers.dev defaults were deleted 2026-10-15. A deployment that names neither lists nothing.
const GATHER_APP = (process.env.NEXT_PUBLIC_GATHER_ORIGINS ?? process.env.NEXT_PUBLIC_GATHER_ORIGIN ?? '').split(',')[0]?.trim() ?? '';
const GATHER_A2A = process.env.NEXT_PUBLIC_GATHER_A2A_BASE ?? '';

export const APP_WORKSPACES: readonly AppWorkspace[] =
  GATHER_APP && GATHER_A2A
    ? [
        {
          id: 'gather27',
          name: 'Gather27',
          clientId: 'gather-app',
          blurb: 'Membership organizations that host a gathering. Invite → Home connect → host org → event in that org’s vault.',
          appHref: GATHER_APP,
          listingHref: GATHER_A2A,
        },
      ]
    : [];

export function workspaceById(id: string): AppWorkspace | undefined {
  return APP_WORKSPACES.find((w) => w.id === id);
}
