/**
 * App Workspaces — a named listing of membership organizations an app supports
 * for invite / register (distinct from person/org/service URL scope in workspace.ts).
 *
 * Gather27 is the first: hosts who redeem an invite and register land on this listing.
 */

import { gatherSurfaceOrigins } from '../whitelabel/config';

export interface AppWorkspace {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly blurb: string;
  readonly appHref: string;
  readonly listingHref: string;
}

// Where Gather lives is an estate fact, and the client registry already reads it from the environment
// (NEXT_PUBLIC_GATHER_ORIGINS / NEXT_PUBLIC_GATHER_ORIGIN for the surfaces, NEXT_PUBLIC_GATHER_A2A_BASE for
// the gate). This listing reads the SAME variables, so a second deployment of this Home sends its members
// to its own Gather rather than to the one these literals name. gatherSurfaceOrigins puts the HOST surface
// first, which is the one a "open the app" link wants. Defaults are today's values, so Faithnet is unchanged.
export interface GatherEnv {
  readonly NEXT_PUBLIC_GATHER_ORIGINS?: string;
  readonly NEXT_PUBLIC_GATHER_ORIGIN?: string;
  readonly NEXT_PUBLIC_GATHER_A2A_BASE?: string;
}

const DEFAULT_GATHER_APP = 'https://gather27-web.richardpedersen3.workers.dev/';
const DEFAULT_GATHER_A2A = 'https://gather27-a2a-production.richardpedersen3.workers.dev';

export function appWorkspacesFromEnv(env: GatherEnv): readonly AppWorkspace[] {
  const surfaces = gatherSurfaceOrigins(env.NEXT_PUBLIC_GATHER_ORIGINS, env.NEXT_PUBLIC_GATHER_ORIGIN);
  const appHref = surfaces.find((u) => u.startsWith('https://')) ?? DEFAULT_GATHER_APP;
  const listingHref = (env.NEXT_PUBLIC_GATHER_A2A_BASE || DEFAULT_GATHER_A2A).replace(/\/$/, '');
  return [
    {
      id: 'gather27',
      name: 'Gather27',
      clientId: 'gather-app',
      blurb: 'Membership organizations that host a gathering. Invite → Home connect → host org → event in that org’s vault.',
      appHref,
      listingHref,
    },
  ];
}

// `as GatherEnv`: every field is optional, so TS's weak-type check rejects ProcessEnv without the cast.
export const APP_WORKSPACES: readonly AppWorkspace[] = appWorkspacesFromEnv(process.env as GatherEnv);

export function workspaceById(id: string): AppWorkspace | undefined {
  return APP_WORKSPACES.find((w) => w.id === id);
}
