'use client';
// The authenticated portal chrome: topbar (brand + workspace switcher + identity) + sidebar
// (desktop) / bottom-nav (mobile) + the routed section as <main>. The active WORKSPACE is
// derived from the URL (spec 315) and scopes the left nav: person / org / connected app.
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { whitelabel } from '../../whitelabel/config';
import { parseWorkspacePath } from '../../lib/workspace';
import { buildNav, bottomNav } from './nav';
import { PortalTopbar } from './PortalTopbar';
import { PortalSidebar } from './PortalSidebar';
import { PortalBottomNav } from './PortalBottomNav';

export function PortalShell({ children, appsBadge }: { children: ReactNode; appsBadge?: number }) {
  const pathname = usePathname();
  const active = parseWorkspacePath(pathname ?? '/');
  const groups = buildNav(whitelabel, { apps: appsBadge }, active);
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
