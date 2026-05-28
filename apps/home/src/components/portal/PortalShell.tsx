'use client';
// The authenticated portal chrome: topbar + sidebar (desktop) / bottom-nav (mobile) +
// the routed section as <main>. Resolves the white-label config into nav data here (a
// shell-level component may import whitelabel; leaf components take props).
import type { ReactNode } from 'react';
import { whitelabel } from '../../whitelabel/config';
import { buildNav, bottomNav } from './nav';
import { PortalTopbar } from './PortalTopbar';
import { PortalSidebar } from './PortalSidebar';
import { PortalBottomNav } from './PortalBottomNav';

export function PortalShell({ children, appsBadge }: { children: ReactNode; appsBadge?: number }) {
  const groups = buildNav(whitelabel, { apps: appsBadge });
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
