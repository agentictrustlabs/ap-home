'use client';
// Desktop left sidebar (≥768px). Active item = amber left border + tint. Coming-soon
// items are navigable (<a aria-disabled>) so the member can see what's planned — never
// removed from the tab order.
import { usePathname } from 'next/navigation';
import type { NavGroup } from './nav';

export function PortalSidebar({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav className="portal-sidebar" aria-label="Portal navigation">
      {groups.map((g, i) => (
        <div className="nav-group" key={g.heading ?? `g${i}`}>
          {g.heading && <div className="nav-group-heading">{g.heading}</div>}
          {g.items.map((item) => {
            const active = pathname === item.href;
            return (
              <a
                key={item.id}
                href={item.href}
                className={`nav-item${active ? ' active' : ''}${item.status === 'soon' ? ' soon' : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-disabled={item.status === 'soon' ? 'true' : undefined}
              >
                <item.Icon size={18} />
                <span className="nav-item-label">{item.label}</span>
                {item.badge ? <span className="nav-item-badge" aria-label={`${item.badge} new`}>{item.badge}</span> : null}
                {item.status === 'soon' && <span className="nav-item-soon">soon</span>}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
