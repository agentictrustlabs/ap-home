// THE APP'S HALF OF THE INTERACTION CONTRACT — spec 361 §2.
//
// A contract names WHERE an act's outcome lives (`navigationTarget: members`) as a route KEY; this
// registry is where THIS app says what that key means here. The split is ADR-0021's: the contract is
// domain knowledge a skills author owns, the resolution is deployment knowledge the app owns, and a
// white-label Home resolves the same key differently. A key with no entry resolves to nothing and the
// surface simply offers no link — the binding refines, its absence breaks nothing.
//
// KEYS, NEVER URLS, on the contract side — the validator refuses anything address-shaped there, because
// a contract that could point a surface at an arbitrary URL would be a phishing primitive. All the
// addressing lives here, in reviewed app code.
import type { Address } from '@agenticprimitives/types';

export interface InteractionRealm {
  kind?: 'person' | 'org' | 'service';
  /** The agent the ask was addressed to — org-scoped targets resolve under it. */
  addressee?: Address | null;
}

/** Resolve a contract navigation key to an href in THIS app, for the realm the ask ran in. */
export function resolveNavigationTarget(target: string, realm: InteractionRealm): { href: string; label: string } | null {
  const org = realm.kind !== 'person' && realm.addressee ? realm.addressee.toLowerCase() : null;
  switch (target) {
    case 'members':
      // Members is an ORG surface; addressed to a person it has no meaning and resolves to nothing
      // rather than to a page that would 404 politely.
      return org ? { href: `/org/${org}/members`, label: 'Open members' } : null;
    case 'treasuries':
      return { href: '/treasuries', label: 'Open treasuries' };
    case 'messages':
      return { href: '/messages', label: 'Open messages' };
    case 'grants':
      // Spec 400 W2 (B4) — the org's grants under the org, the person's under theirs.
      return org ? { href: `/org/${org}/grants`, label: 'Open grants' } : { href: '/grants', label: 'Open grants' };
    case 'search':
      // Spec 400 W2 (B5) — a PERSON'S surface: the search is over their own tier.
      return realm.kind === 'person' || !realm.kind ? { href: '/search', label: 'Open search' } : null;
    case 'agents':
      return { href: '/agents', label: 'Open agents' };
    case 'household':
      // A PERSON'S surface: an organization has members, not a household, and resolving this key under
      // an org would offer a page whose subject does not exist there.
      return realm.kind === 'person' || !realm.kind ? { href: '/household', label: 'Open household' } : null;
    case 'profile':
      return realm.kind === 'person' || !realm.kind ? { href: '/profile', label: 'Open profile' } : null;
    case 'settings':
      return { href: '/settings', label: 'Open settings' };
    case 'work':
      return org ? { href: `/org/${org}/work`, label: 'Open work' } : { href: '/work', label: 'Open work' };
    case 'build':
      // Spec 398 §9 — a WORKSPACE's surface: the build runs are the organization's records.
      return org ? { href: `/org/${org}/build`, label: 'Open build' } : null;
    default:
      return null;
  }
}
