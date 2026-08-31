'use client';
import Link from 'next/link';
// Mobile bottom tab bar (<768px): Home + the first destinations, plus a "More" tab that opens a full
// nav drawer with the complete tree.
//
// The drawer MUST carry the Settings groups too. The desktop pattern puts them in a second pane, and
// both nav columns are `display:none` under 768px — so until this was wired, tapping Settings on a phone
// landed on Profile and the other eleven settings surfaces could only be reached by typing a URL. A
// two-pane pattern has to design its narrow branch or the pattern deletes function.
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import type { NavGroup, NavItem, SettingsGroup } from './nav';
import { MenuIcon, XIcon } from '../shared/Icons';

function DrawerItem({ item, active, onGo }: { item: NavItem; active: boolean; onGo: () => void }) {
  return (
    <Link
      href={item.href}
      prefetch={false}
      className={`nav-item${active ? ' active' : ''}${item.status === 'soon' ? ' soon' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onGo}
    >
      <item.Icon size={18} />
      <span className="nav-item-label">{item.label}</span>
      {item.badge ? <span className="nav-item-badge" aria-label={`${item.badge} new`}>{item.badge}</span> : null}
      {item.status === 'soon' && <span className="nav-item-soon">soon</span>}
    </Link>
  );
}

export function PortalBottomNav({
  groups, tabs, settings, workspaceName,
}: { groups: NavGroup[]; tabs: NavItem[]; settings?: SettingsGroup[]; workspaceName?: string }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);

  return (
    <>
      <nav className="portal-bottomnav" aria-label="Portal navigation">
        {tabs.map((item) => {
          const active = pathname === item.href;
          return (
            <Link key={item.id} href={item.href} prefetch={false} className={`bottomnav-tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
              <item.Icon size={22} />
              <span>{item.label}</span>
              {item.badge ? <span className="bottomnav-badge" aria-label={`${item.badge} unread`}>{item.badge}</span> : null}
            </Link>
          );
        })}
        <button type="button" className="bottomnav-tab" aria-label="More" onClick={() => setDrawer(true)}>
          <MenuIcon size={22} />
          <span>More</span>
        </button>
      </nav>

      {drawer && (
        <div className="nav-drawer" role="dialog" aria-modal="true" aria-label="Portal navigation">
          <div className="nav-drawer-head">
            <span>Your portal</span>
            <button type="button" aria-label="Close" onClick={() => setDrawer(false)}><XIcon size={20} /></button>
          </div>
          {groups.map((g, i) => (
            <div className="nav-group" key={g.id ?? g.heading ?? `g${i}`}>
              {/* In the drawer every area is simply open: there is no second pane to defer to, and a
                  collapsed section inside a sheet you already opened is a second door for nothing. */}
              {g.heading && g.items.length > 1 && <div className="nav-group-heading">{g.heading}</div>}
              {g.items.map((item) => (
                <DrawerItem key={item.id} item={item} active={pathname === item.href} onGo={() => setDrawer(false)} />
              ))}
            </div>
          ))}
          {!!settings?.length && (
            <>
              <div className="nav-group region-start">
                <div className="nav-group-heading">Settings{workspaceName ? ` · ${workspaceName}` : ''}</div>
              </div>
              {settings.map((g) => (
                <div className="nav-group" key={g.heading}>
                  <div className="nav-group-heading">{g.heading}</div>
                  {g.items.map((item) => (
                    <DrawerItem key={item.id} item={item} active={pathname === item.href} onGo={() => setDrawer(false)} />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
