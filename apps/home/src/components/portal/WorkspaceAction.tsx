'use client';
// The primary action for the currently-selected workspace, shown just right of the switcher (spec 315):
//   • person  → "Add organization"  → the org-create surface (/organizations)
//   • org      → "Invite member"     → the Members surface, where the Invite panel now lives (spec 324 §12)
// URL-derived scope, same as the sidebar. Kept minimal; the invite flow itself is a follow-up.
import { usePathname, useRouter } from 'next/navigation';
import { parseWorkspacePath, orgHref } from '../../lib/workspace';

const STYLE: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '.35rem', padding: '.34rem .7rem',
  borderRadius: 8, fontSize: '.82rem', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
  color: 'var(--color-amber-800)', background: 'var(--color-amber-50)',
  border: '1px solid var(--color-amber-200)', textDecoration: 'none',
};

export function WorkspaceAction() {
  const pathname = usePathname();
  const router = useRouter();
  const active = parseWorkspacePath(pathname ?? '/');

  if (active.kind === 'person') {
    return (
      <button type="button" style={STYLE} onClick={() => router.push('/organizations')} title="Create a new organization">
        ＋ Add organization
      </button>
    );
  }
  if (active.kind === 'org') {
    return (
      <button type="button" style={STYLE} onClick={() => router.push(orgHref(active.org, 'membership'))} title="Invite someone to this organization">
        ✉ Invite member
      </button>
    );
  }
  return null;
}
