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
import { useInboxView } from '../../home/use-inbox';
import { nameLabel } from '../../lib/domain';

export function PortalShell({ children, appsBadge }: { children: ReactNode; appsBadge?: number }) {
  const pathname = usePathname();
  const active = parseWorkspacePath(pathname ?? '/');
  const { session } = useSession();
  const { agents } = useManagedAgents(session?.token ?? null);
  const { view } = useInboxView(active.kind === 'person' ? session : null);
  const inboxUnread = active.kind === 'person' ? (view?.summary.unreadTotal ?? 0) : 0;
  const activeAgent = active.kind === 'org'
    ? agents.find((a) => a.agent.toLowerCase() === active.org.toLowerCase())
    : active.kind === 'service'
      ? agents.find((a) => a.agent.toLowerCase() === active.agent.toLowerCase())
      : undefined;
  const rel = active.kind === 'org' ? (activeAgent?.relationship ?? 'member') : 'steward';
  const workspaceName = activeAgent?.name ? nameLabel(activeAgent.name) : undefined;
  const groups = buildNav(whitelabel, {
    apps: appsBadge,
    inbox: inboxUnread > 0 ? inboxUnread : undefined,
  }, active, rel, workspaceName);
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
