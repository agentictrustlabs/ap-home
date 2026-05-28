'use client';
// Mobile bottom tab bar (<768px): Home + the first destinations, plus a "More" tab that
// opens a full nav drawer with the complete tree (incl. coming-soon sections).
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import type { NavGroup, NavItem } from './nav';
import { MenuIcon, XIcon } from '../shared/Icons';

export function PortalBottomNav({ groups, tabs }: { groups: NavGroup[]; tabs: NavItem[] }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);

  return (
    <>
      <nav className="portal-bottomnav" aria-label="Portal navigation">
        {tabs.map((item) => {
          const active = pathname === item.href;
          return (
            <a key={item.id} href={item.href} className={`bottomnav-tab${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
              <item.Icon size={22} />
              <span>{item.label}</span>
            </a>
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
            <div className="nav-group" key={g.heading ?? `g${i}`}>
              {g.heading && <div className="nav-group-heading">{g.heading}</div>}
              {g.items.map((item) => (
                <a
                  key={item.id}
                  href={item.href}
                  className={`nav-item${pathname === item.href ? ' active' : ''}${item.status === 'soon' ? ' soon' : ''}`}
                  aria-disabled={item.status === 'soon' ? 'true' : undefined}
                  onClick={() => setDrawer(false)}
                >
                  <item.Icon size={18} />
                  <span className="nav-item-label">{item.label}</span>
                  {item.status === 'soon' && <span className="nav-item-soon">soon</span>}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
