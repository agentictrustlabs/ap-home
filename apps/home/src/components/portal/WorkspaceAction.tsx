'use client';
// The primary action for the currently-selected workspace, shown just right of the switcher (spec 315):
//   • person  → "Add organization"  → the org-create surface (/organizations)
//   • org      → (nothing in the header) — inviting lives on the org's Members page only (owner, 2026-10-02)
// URL-derived scope, same as the sidebar. Kept minimal; the invite flow itself is a follow-up.
import { usePathname, useRouter } from 'next/navigation';
import { parseWorkspacePath } from '../../lib/workspace';


export function WorkspaceAction() {
  const pathname = usePathname();
  const router = useRouter();
  const active = parseWorkspacePath(pathname ?? '/');

  if (active.kind === 'person') {
    return (
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => router.push('/agents')} title="Create a new organization">
        Add organization
      </button>
    );
  }
  // A PERSONA gets the same offer as you do: another of your names may steward organizations of its own —
  // which is the whole reason for switching into it rather than just reading its vault.
  if (active.kind === 'persona') {
    return (
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => router.push('/agents')} title="Create a new organization">
        Add organization
      </button>
    );
  }
  // owner (2026-10-02): the org header no longer carries "Invite member" — inviting lives on the organization's
  // Members page only, so the topbar stays a switch-and-act bar and the long org name is not crowded by a button.
  return null;
}
