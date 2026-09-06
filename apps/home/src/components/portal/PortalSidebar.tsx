'use client';
// Desktop left sidebar (≥768px) — spec 348, after the 2026-08-31 UX review and the owner's follow-up.
//
// ONE grammar for every second level: a section too long to hang under a heading in a 240px column is a
// ROW WITH A RIGHT CARET that opens a PANE beside the nav. Stewardship and Settings both work that way.
//
// There is deliberately no accordion. The first build had both — collapsible areas AND a pane — which
// meant the same visual (small-caps heading) said two different things, and three collapsed headings
// cost ~60px each to show nothing. Small-caps uppercase is now only ever a static label, inside a pane.
//
// Every item is a next/link, NOT a bare <a>: an anchor in the App Router is a full document load, so
// clicking any nav item tore down the app and re-ran session bootstrap and every page fetch from cold.
import { IdentityChip } from './IdentityChip';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavGroup, NavItem, PaneId, SettingsGroup } from './nav';
import { ChevronRightIcon } from '../shared/Icons';

function Item({ item, active }: { item: NavItem; active: boolean }) {
  // A row that cannot do its job yet is SHOWN and not navigable, with the reason on it — so a person can
  // see what becomes available and what unlocks it, instead of wondering where a page went. It is not a
  // link at all: an <a> that goes nowhere is a broken link, and `aria-disabled` on a working link lies.
  if (item.disabledReason) {
    return (
      <span className="nav-item nav-item-blocked" aria-disabled="true" title={item.disabledReason}>
        <item.Icon size={18} />
        <span className="nav-item-label">{item.label}</span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      prefetch={false}
      className={`nav-item${active ? ' active' : ''}${item.status === 'soon' ? ' soon' : ''}${item.opensPane ? ' nav-item-pane' : ''}`}
      // `page` is the exact page; `true` is "the current one within a set" — a pane row is lit for its
      // whole section, and it is not the page you are looking at.
      aria-current={active ? (item.opensPane ? 'true' : 'page') : undefined}
    >
      <item.Icon size={18} />
      <span className="nav-item-label">{item.label}</span>
      {item.badge ? <span className="nav-item-badge" aria-label={`${item.badge} new`}>{item.badge}</span> : null}
      {item.status === 'soon' && <span className="nav-item-soon">soon</span>}
      {item.opensPane && <ChevronRightIcon size={16} className="nav-caret-right" aria-hidden />}
    </Link>
  );
}

export function PortalSidebar({
  groups, panes, workspaceName,
}: {
  groups: NavGroup[];
  /** Every pane this workspace can show, by id. The OPEN one is whichever holds the current route —
   *  it is where you are, not a preference, so nothing about it is remembered. */
  panes?: Partial<Record<PaneId, SettingsGroup[]>>;
  workspaceName?: string;
}) {
  const pathname = usePathname();
  const isActive = (href: string): boolean => pathname === href;
  // A pane item stays lit — and its pane stays OPEN — for everything BENEATH it. The Agent Card item is
  // `…/card`, and editing one is `…/card/<id>`: on exact equality the pane closed the moment you opened
  // a card, which is exactly when you most need the way back. Segment-aware so `/profile` never matches
  // `/profiles`.
  const isWithin = (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

  const openPane = (Object.keys(panes ?? {}) as PaneId[]).find((id) =>
    (panes?.[id] ?? []).some((g) => g.items.some((i) => isWithin(i.href))),
  );
  const openGroups = openPane ? panes![openPane]! : null;
  const PANE_TITLE: Record<PaneId, string> = { stewardship: 'Stewardship', settings: 'Settings' };

  return (
    <div className="portal-sidebar-wrap">
      <nav className="portal-sidebar" aria-label="Portal navigation">
        <div className="portal-sidebar-scroll">
        {groups.map((g, i) => (
          <div
            className={`nav-group${g.startsRegion ? ' region-start' : ''}${g.isExit ? ' region-exit' : ''}`}
            key={g.id ?? g.heading ?? `g${i}`}
          >
            {g.heading && <div className="nav-group-heading">{g.heading}</div>}
            {g.items.map((item) => (
              <Item
                key={item.id}
                item={item}
                active={item.opensPane ? item.opensPane === openPane || isActive(item.href) : isActive(item.href)}
              />
            ))}
          </div>
        ))}
        </div>
        {/* THE PERSON, at the foot of the nav. It was in the topbar, where the Ask flyout — a fixed
            right-hand panel at a higher stacking level — painted over the menu that holds Sign out. Here
            it is out from under the Ask entirely, and the menu opens upward from its own corner. Outside
            the scrolling area on purpose: an absolutely-positioned panel inside `overflow-y:auto` is a
            clipped panel. */}
        <div className="portal-sidebar-foot">
          <IdentityChip placement="sidebar-foot" />
        </div>
      </nav>
      {openGroups && (
        <nav
          className="portal-settings-pane"
          aria-label={workspaceName ? `${PANE_TITLE[openPane!]} for ${workspaceName}` : PANE_TITLE[openPane!]}
        >
          {/* The header is DISCLOSURE, not decoration: a person's pane and an org's are near-identical
              lists, but the org's writes go to that organization's vault under your stewardship
              delegation. Which agent you are working on belongs on this screen. */}
          <div className="pane-head">
            <span className="pane-head-eyebrow">{PANE_TITLE[openPane!]}</span>
            <span className="pane-head-name" title={workspaceName}>{workspaceName ?? 'Your agent'}</span>
          </div>
          {openGroups.map((g) => (
            <div className="nav-group" key={g.heading}>
              <div className="nav-group-heading">{g.heading}</div>
              {g.items.map((item) => <Item key={item.id} item={item} active={isWithin(item.href)} />)}
            </div>
          ))}
        </nav>
      )}
    </div>
  );
}
