'use client';
// The authenticated portal chrome: topbar (brand + workspace switcher + identity) + sidebar
// (desktop) / bottom-nav (mobile) + the routed section as <main>. The active WORKSPACE is
// derived from the URL (spec 315) and scopes the left nav: person / org / connected app.
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { whitelabel } from '../../whitelabel/config';
import { useSession } from '../../context/session';
import { useManagedAgents } from './ManagedAgents';
import { parseWorkspacePath } from '../../lib/workspace';
import { buildNav, bottomNav } from './nav';
import { PortalTopbar } from './PortalTopbar';
import { PortalSidebar } from './PortalSidebar';
import { PortalBottomNav } from './PortalBottomNav';

export function PortalShell({ children, appsBadge }: { children: ReactNode; appsBadge?: number }) {
  const pathname = usePathname();
  const active = parseWorkspacePath(pathname ?? '/');
  // spec 318: the active org's relationship (steward = custody, member = authority-only) scopes the nav.
  const { session } = useSession();
  const { agents } = useManagedAgents(session?.token ?? null);
  // Least-privilege default: an org NOT in the managed set (an invitee's guest visit, or the set still
  // loading) renders the MEMBER nav — stewards are always in the set, so the safe flash is less→more.
  const rel = active.kind === 'org'
    ? (agents.find((a) => a.agent.toLowerCase() === active.org.toLowerCase())?.relationship ?? 'member')
    : 'steward';
  const groups = buildNav(whitelabel, { apps: appsBadge }, active, rel);
  const tabs = bottomNav(groups);
  return (
    <div className="portal-root">
      <PortalTopbar brandName={whitelabel.brand.name} />
      <div className="portal-body">
        <PortalSidebar groups={groups} />
        <main className="portal-main">{children}</main>
      </div>
      <PortalBottomNav groups={groups} tabs={tabs} />
    </div>
  );
}
