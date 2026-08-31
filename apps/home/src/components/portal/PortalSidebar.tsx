'use client';
// Desktop left sidebar (≥768px) — spec 348.
//
// Two things live here now: the main nav (areas, some collapsible) and the SETTINGS PANE, a second
// column that opens to the right of the main nav when the current route is a settings route. The pane is
// not an accordion because an organization's settings hold twelve items, and a twelve-item accordion in
// a sidebar is a list you scroll past, not a place you navigate.
//
// Active item = amber left border + tint. Coming-soon items stay navigable (`<a aria-disabled>`) so the
// member can see what is planned — never removed from the tab order.
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { NavGroup, NavItem, SettingsGroup } from './nav';

const OPEN_KEY = 'ap.nav.open';

/** Remembered open/closed state per area. A convenience, never authority — a lost preference costs one
 *  click, so every read and write is guarded (private windows, cleared storage, blocked site data). */
function useAreaState(): [Record<string, boolean>, (id: string, open: boolean) => void] {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_KEY);
      if (raw) setOpen(JSON.parse(raw) as Record<string, boolean>);
    } catch { /* no stored preference — every area falls back to its default */ }
  }, []);
  const set = (id: string, next: boolean): void => {
    setOpen((prev) => {
      const merged = { ...prev, [id]: next };
      try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(merged)); } catch { /* not fatal */ }
      return merged;
    });
  };
  return [open, set];
}

function Item({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
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
}

export function PortalSidebar({ groups, settings }: { groups: NavGroup[]; settings?: SettingsGroup[] }) {
  const pathname = usePathname();
  const [openState, setOpen] = useAreaState();
  const isActive = (href: string): boolean => pathname === href;
  // The pane is open when you are in it — it is where you are, not a preference (§5).
  const settingsOpen = !!settings?.length && settings.some((g) => g.items.some((i) => isActive(i.href)));

  return (
    <div className="portal-sidebar-wrap" style={{ display: 'flex', minHeight: 0 }}>
      <nav className="portal-sidebar" aria-label="Portal navigation">
        {groups.map((g, i) => {
          const holdsCurrent = g.items.some((it) => isActive(it.href));
          // The area containing the current route is always expanded, whatever the stored state.
          const expanded = !g.collapsible || holdsCurrent || (openState[g.id ?? ''] ?? g.defaultOpen ?? true);
          return (
            <div className="nav-group" key={g.id ?? g.heading ?? `g${i}`}>
              {g.heading && (g.collapsible ? (
                <button
                  type="button"
                  className="nav-group-heading nav-group-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(g.id ?? g.heading!, !expanded)}
                  style={{ display: 'flex', alignItems: 'center', gap: '.35rem', width: '100%', background: 'none', border: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' }}
                >
                  <span aria-hidden style={{ display: 'inline-block', transition: 'transform .12s', transform: expanded ? 'rotate(90deg)' : 'none' }}>›</span>
                  {g.heading}
                </button>
              ) : <div className="nav-group-heading">{g.heading}</div>)}
              {expanded && g.items.map((item) => <Item key={item.id} item={item} active={isActive(item.href)} />)}
            </div>
          );
        })}
      </nav>
      {settingsOpen && (
        <nav className="portal-settings-pane" aria-label="Settings">
          {settings!.map((g) => (
            <div className="nav-group" key={g.heading}>
              <div className="nav-group-heading">{g.heading}</div>
              {g.items.map((item) => <Item key={item.id} item={item} active={isActive(item.href)} />)}
            </div>
          ))}
        </nav>
      )}
    </div>
  );
}
