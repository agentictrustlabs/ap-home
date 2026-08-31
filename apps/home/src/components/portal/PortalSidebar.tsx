'use client';
// Desktop left sidebar (≥768px) — spec 348, redesigned after the 2026-08-31 UX review.
//
// Two columns: the main nav, and the SETTINGS PANE that opens beside it while you are inside settings.
//
// THE VISUAL GRAMMAR, because two of these looked identical before and meant different things:
//   • a ROW with a LEFT caret  → expands in place (an area);
//   • a ROW with a RIGHT caret → opens the pane beside it (Settings);
//   • SMALL-CAPS UPPERCASE     → a static label, and now ONLY in the pane. Nothing interactive uses it.
// The area toggles used to be styled as `.nav-group-heading` on a <button>, which the bare `button {}`
// element rule then centred, enlarged and bolded — so three dead headings out-shouted the live items
// above them. They are rows now, and they own their class rather than borrowing a label's.
//
// Every item is a next/link, NOT a bare <a>: an anchor in the App Router is a full document load, so
// clicking any nav item tore down the app and re-ran session bootstrap and every page fetch from cold.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavGroup, NavItem, SettingsGroup } from './nav';
import { ChevronRightIcon } from '../shared/Icons';

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

function Item({ item, active, variant }: { item: NavItem; active: boolean; variant?: 'pane' }) {
  return (
    <Link
      href={item.href}
      prefetch={false}
      className={`nav-item${active ? ' active' : ''}${item.status === 'soon' ? ' soon' : ''}${variant === 'pane' ? ' nav-item-pane' : ''}`}
      // `page` is the exact page; `true` is "the current one within a set" — Settings is active for its
      // whole section, and it is not the page you are looking at.
      aria-current={active ? (variant === 'pane' ? 'true' : 'page') : undefined}
    >
      <item.Icon size={18} />
      <span className="nav-item-label">{item.label}</span>
      {item.badge ? <span className="nav-item-badge" aria-label={`${item.badge} new`}>{item.badge}</span> : null}
      {item.status === 'soon' && <span className="nav-item-soon">soon</span>}
      {variant === 'pane' && <ChevronRightIcon size={16} className="nav-caret-right" aria-hidden />}
    </Link>
  );
}

export function PortalSidebar({
  groups, settings, workspaceName,
}: { groups: NavGroup[]; settings?: SettingsGroup[]; workspaceName?: string }) {
  const pathname = usePathname();
  const [openState, setOpen] = useAreaState();
  const isActive = (href: string): boolean => pathname === href;
  // The pane is open when you are in it — it is where you are, not a preference.
  const settingsOpen = !!settings?.length && settings.some((g) => g.items.some((i) => isActive(i.href)));

  return (
    <div className="portal-sidebar-wrap">
      <nav className="portal-sidebar" aria-label="Portal navigation">
        {groups.map((g, i) => {
          const holdsCurrent = g.items.some((it) => isActive(it.href));
          // An area with fewer than two children is a heading with extra clicks — render it as a plain
          // row. This reverses itself for free when an area grows (spec §8.5).
          const asArea = g.collapsible && g.items.length > 1;
          const expanded = !asArea || holdsCurrent || (openState[g.id ?? ''] ?? g.defaultOpen ?? true);
          const cls = `nav-group${g.startsRegion ? ' region-start' : ''}${g.isExit ? ' region-exit' : ''}`;
          return (
            <div className={cls} key={g.id ?? g.heading ?? `g${i}`}>
              {asArea ? (
                <>
                  <button
                    type="button"
                    className="nav-area-toggle"
                    aria-expanded={expanded}
                    onClick={() => setOpen(g.id ?? g.heading!, !expanded)}
                  >
                    <ChevronRightIcon size={16} className="nav-caret" aria-hidden />
                    <span className="nav-item-label">{g.heading}</span>
                  </button>
                  {expanded && (
                    <div className="nav-area-items">
                      {g.items.map((item) => <Item key={item.id} item={item} active={isActive(item.href)} />)}
                    </div>
                  )}
                </>
              ) : (
                g.items.map((item) => (
                  <Item
                    key={item.id}
                    item={item}
                    active={item.id === 'settings' ? settingsOpen || isActive(item.href) : isActive(item.href)}
                    variant={item.id === 'settings' ? 'pane' : undefined}
                  />
                ))
              )}
            </div>
          );
        })}
      </nav>
      {settingsOpen && (
        <nav className="portal-settings-pane" aria-label={workspaceName ? `Settings for ${workspaceName}` : 'Settings'}>
          {/* The header is DISCLOSURE, not decoration: a person's pane and an org's are near-identical
              lists, but the org's writes go to that organization's vault under your stewardship
              delegation. Which vault you are about to write to should be on this screen. */}
          <div className="pane-head">
            <span className="pane-head-eyebrow">Settings</span>
            <span className="pane-head-name" title={workspaceName}>{workspaceName ?? 'Your agent'}</span>
          </div>
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
