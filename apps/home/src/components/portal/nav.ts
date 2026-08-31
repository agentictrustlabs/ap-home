// Portal navigation (spec 348) — ONE shape for every agent class, scoped to the workspace the header
// switcher selected (spec 315). The white-label config still decides which optional SERVICES exist
// (devices / connected apps drive the user menu); it no longer decides the shape of the left nav.
import type { WhiteLabelConfig } from '../../whitelabel/schema';
import type { WorkspaceScope } from '../../lib/workspace';
import { orgHref, serviceHref, workspaceHref } from '../../lib/workspace';
import {
  UserIcon, BuildingIcon, LandmarkIcon, DatabaseIcon, TagIcon, AwardIcon, LinkIcon, ShieldIcon, HistoryIcon, HomeIcon,
  ChatIcon, HashIcon, GlobeIcon, BotIcon, CheckCircleIcon, SettingsIcon, CodeIcon, IdCardIcon,
  type IconComponent,
} from '../shared/Icons';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  Icon: IconComponent;
  status: 'live' | 'soon';
  badge?: number;
}
export interface NavGroup {
  /** Stable key for the remembered open/closed state; required when `collapsible`. */
  id?: string;
  heading?: string;
  items: NavItem[];
  /** spec 348 §5 — a named AREA collapses; the top band never does. */
  collapsible?: boolean;
  /** Whether it starts open when the current route is not inside it. Stewardship starts closed. */
  defaultOpen?: boolean;
}

/** spec 348 §2.3 — the Settings pane's groups. Same shape as a nav group, rendered in the second pane
 *  rather than the sidebar, so `collapsible` never applies: the pane is already the disclosure. */
export type SettingsGroup = { heading: string; items: NavItem[] };


/**
 * spec 348 — ONE nav shape for every agent class.
 *
 * Per-class variation is the PRESENCE OR ABSENCE OF A WHOLE AREA, never a different arrangement of the
 * same items. Before this, the three navs disagreed about where the same thing lived — Trust graph was in
 * Manage for an org and Discovery for a person, a service had no Library because nobody wired one, and
 * `Manage` had become the bucket for nine unrelated things. The shape is now:
 *
 *   top band (4, never collapsible) · Work · Stewardship ▸ · Settings → · Records ▸ · Attestations ▸
 *
 * The test for the top band: you go there to WATCH or TAKE PART. Everything you go to in order to change
 * how the agent behaves is Settings, which is a second pane (`buildSettingsPane`), not an area — twelve
 * items in a sidebar accordion is a list you scroll past, not a place you navigate.
 *
 * Account-level surfaces (Security, Connected, Your apps, Network) are NOT here: they are about the
 * signed-in person and the deployment, not the agent in this workspace, and live in the topbar's user
 * menu (`buildUserMenu`).
 */
export function buildNav(
  wl: WhiteLabelConfig,
  badges: { apps?: number; inbox?: number } = {},
  active: WorkspaceScope = { kind: 'person' },
  // spec 318: 'member' = authority-only — the nav shows ONLY the surfaces membership grants
  // (discussions/work); every custody surface is steward-only and its server re-verifies control anyway
  // (defense in depth, never nav-only).
  orgRelationship: 'steward' | 'member' = 'steward',
  /** Display name of the active org/service workspace — headed into the sidebar so you always know where you are. */
  workspaceName?: string,
): NavGroup[] {
  const isPerson = active.kind === 'person';
  const href = (page: string): string => workspaceHref(active, page);
  const backHome: NavGroup = {
    items: [{ id: 'back-home', label: 'Back to your home', href: '/', Icon: HomeIcon, status: 'live' }],
  };

  // ── the top band: the same four questions of any agent ────────────────────────────────────────────
  //    what is it · who is talking to it · what has it done · what does it hold
  const overviewHref = isPerson ? '/' : active.kind === 'service' ? serviceHref(active.agent) : orgHref(active.org, 'overview');
  const top: NavGroup = {
    ...(isPerson ? {} : { heading: workspaceName ?? (active.kind === 'org' ? 'Organization' : 'Service') }),
    items: [
      { id: 'overview', label: 'Overview', href: overviewHref, Icon: isPerson ? HomeIcon : active.kind === 'org' ? BuildingIcon : LandmarkIcon, status: 'live' },
      { id: 'messages', label: 'Messages', href: href('messages'), Icon: ChatIcon, status: 'live', ...(badges.inbox ? { badge: badges.inbox } : {}) },
      // spec 310's control-plane timeline, in the plural because the band is a place.
      { id: 'activities', label: 'Activities', href: href('activities'), Icon: HistoryIcon, status: 'live' },
      { id: 'library', label: 'Library', href: href('library'), Icon: DatabaseIcon, status: 'live' },
    ],
  };

  // An org MEMBER (spec 318) gets participation only. Adding areas must never widen what membership grants.
  if (active.kind === 'org' && orgRelationship === 'member') {
    return [
      top,
      { items: [
        { id: 'org-discussions', label: 'Discussions', href: orgHref(active.org, 'discussions'), Icon: HashIcon, status: 'live' },
        { id: 'work', label: 'Work', href: orgHref(active.org, 'work'), Icon: CheckCircleIcon, status: 'live' },
      ] },
      backHome,
    ];
  }

  const groups: NavGroup[] = [top];

  // Discussions is a PARTICIPATION surface (the settings pane configures the replies — spec 348 §2.3).
  if (active.kind === 'org') {
    groups.push({ items: [{ id: 'org-discussions', label: 'Discussions', href: orgHref(active.org, 'discussions'), Icon: HashIcon, status: 'live' }] });
  }

  // ── Work (§2.1b): a participation surface beside the band, not inside it — the four stay four. ────
  if (active.kind !== 'service') {
    groups.push({ items: [{ id: 'work', label: 'Work', href: href('work'), Icon: CheckCircleIcon, status: 'live' }] });
  }

  // ── Stewardship (§2.2): what this agent stewards FOR someone. A service is stewarded, it does not
  //    steward. Collapsed by default — it is a directory, not a destination. ─────────────────────────
  if (active.kind !== 'service') {
    const stewardItems: NavItem[] = isPerson
      ? [
          { id: 'organizations', label: 'Organizations', href: '/organizations', Icon: BuildingIcon, status: 'live' },
          { id: 'treasuries', label: 'Treasuries', href: '/treasuries', Icon: LandmarkIcon, status: 'live' },
          { id: 'alliances', label: 'Alliances', href: '/alliances', Icon: LinkIcon, status: 'live' },
          { id: 'workspaces', label: 'Workspaces', href: '/workspaces', Icon: GlobeIcon, status: 'live' },
        ]
      : [{ id: 'org-treasury', label: 'Treasuries', href: orgHref(active.org, 'treasury'), Icon: LandmarkIcon, status: 'live' }];
    groups.push({ id: 'stewardship', heading: 'Stewardship', items: stewardItems, collapsible: true, defaultOpen: false });
  }

  // ── Settings: ONE item that opens the second pane (§2.3). ─────────────────────────────────────────
  groups.push({ items: [{ id: 'settings', label: 'Settings', href: href('settings'), Icon: SettingsIcon, status: 'live' }] });

  // ── Records + Attestations: their own areas (§2.4/§2.5). ──────────────────────────────────────────
  groups.push({ id: 'records', heading: 'Records', items: [
    { id: 'records-all', label: 'All records', href: href('records'), Icon: DatabaseIcon, status: 'live' },
  ], collapsible: true, defaultOpen: false });
  // Attestations: person-only today. A managed agent CAN sign statements, so the area applies in
  // principle — but none has an agent-scoped page yet, and §5 says an empty area renders nothing.
  if (isPerson) {
    groups.push({ id: 'attestations', heading: 'Attestations', items: [
      { id: 'attestations-all', label: 'Signed statements', href: '/attestations', Icon: AwardIcon, status: 'live' },
    ], collapsible: true, defaultOpen: false });
  }

  if (!isPerson) groups.push(backHome);
  return groups.filter((g) => g.items.length > 0);
}

/**
 * spec 348 §2.3 — the Settings pane: everything that changes how the agent behaves, how it is described,
 * and who is inside it. Grouped, because a flat twelve is a list you scroll past in any column width.
 *
 * Three of today's pages are split here by WHAT THEY ARE rather than by the screen they landed on:
 * `Agent` was three unrelated configurations behind sub-tabs (Ask / Discussion replies / Playbook);
 * `Card & Projections` was a card AND two projections (ADR-0062 says those are different things); and
 * `Metadata` was three tiers that are not one task — its vault tier belongs in Profile, its published
 * tiers under the name they are published with.
 */
export function buildSettingsPane(
  active: WorkspaceScope = { kind: 'person' },
  orgRelationship: 'steward' | 'member' = 'steward',
): SettingsGroup[] {
  if (active.kind === 'org' && orgRelationship === 'member') return [];
  const href = (page: string): string => workspaceHref(active, page);
  const isOrg = active.kind === 'org';
  const isPerson = active.kind === 'person';

  const identity: NavItem[] = [
    { id: 'set-profile', label: 'Profile', href: href('profile'), Icon: UserIcon, status: 'live' },
    // Naming owns the name, its records AND the A2A endpoint: the endpoint was set inside the card
    // editor because the card needs it, but it is published under the name and read by resolution.
    { id: 'set-naming', label: 'Naming', href: href('naming'), Icon: TagIcon, status: 'live' },
    { id: 'set-card', label: 'Agent Card', href: href('card'), Icon: IdCardIcon, status: 'live' },
    { id: 'set-registry', label: 'Registry', href: href('registry'), Icon: DatabaseIcon, status: 'live' },
    // spec 338 §20. Person-only today — the four choices (naming/listing/resolution/inbound) have no
    // agent-scoped surface yet, and an item that 404s is worse than one that is honestly absent.
    ...(isPerson ? [{ id: 'set-visibility', label: 'Visibility', href: '/visibility', Icon: GlobeIcon, status: 'live' as const }] : []),
    { id: 'set-trust-graph', label: 'Trust graph', href: href('trust-graph'), Icon: ShieldIcon, status: 'live' },
  ];
  // Behaviour varies by class, and it varies because the SURFACES differ — not to make the pane shorter:
  //   • a service agent has no assistant configuration; its Playbook IS what it answers as, so `Ask`
  //     would point at the same page under a second name;
  //   • only a person's agent has a discussion-reply panel distinct from its assistant. An org's
  //     discussion behaviour is the assistant.
  // An item that would duplicate another is worse than an absent one (§5's empty rule).
  const behaviour: NavItem[] = [
    ...(active.kind !== 'service' ? [{ id: 'set-ask', label: 'Ask', href: href('ask'), Icon: BotIcon, status: 'live' as const }] : []),
    // NOT "Discussions" — that is the top band, where you take part. This edits the replies.
    ...(isPerson ? [{ id: 'set-discussion', label: 'Discussion replies', href: '/discussion-replies', Icon: HashIcon, status: 'live' as const }] : []),
    { id: 'set-skills', label: 'Skills', href: href('capabilities'), Icon: AwardIcon, status: 'live' },
    { id: 'set-playbook', label: 'Playbook', href: href('playbook'), Icon: CodeIcon, status: 'live' },
  ];
  const access: NavItem[] = [
    ...(isOrg ? [{ id: 'set-members', label: 'Members', href: orgHref(active.org, 'members'), Icon: UserIcon, status: 'live' as const }] : []),
    // A person's access — their credentials and the delegations they hold — is Security, in the user
    // menu (§4): it is about the signed-in person, not about an agent in a workspace.
    ...(!isPerson ? [{ id: 'set-access', label: 'Access', href: href('access'), Icon: ShieldIcon, status: 'live' as const }] : []),
    // spec 342's lifecycle page, renamed: it answers "is this active", not "how is it configured" —
    // and `Settings` now names the pane.
    ...(isOrg ? [{ id: 'set-status', label: 'Status', href: orgHref(active.org, 'status'), Icon: SettingsIcon, status: 'live' as const }] : []),
  ];

  return [
    { heading: 'Identity & presence', items: identity },
    { heading: 'Behaviour', items: behaviour },
    { heading: 'People & access', items: access },
  ].filter((g) => g.items.length > 0);
}

/** spec 348 §4 — the topbar user menu: about the signed-in PERSON and the deployment, not about the
 *  agent in this workspace. Network is here rather than per-agent because it is one substrate for every
 *  agent, and a per-agent item for a non-per-agent fact invents a distinction that does not exist. */
export function buildUserMenu(wl: WhiteLabelConfig): NavItem[] {
  const items: NavItem[] = [{ id: 'you', label: 'Your profile', href: '/you', Icon: UserIcon, status: 'live' }];
  if (wl.services.devices) items.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  if (wl.services.connectedApps) {
    items.push({ id: 'apps', label: 'Connected', href: '/apps', Icon: LinkIcon, status: 'live' });
    items.push({ id: 'developer', label: 'Your apps', href: '/developer', Icon: CodeIcon, status: 'live' });
  }
  items.push({ id: 'network', label: 'Network', href: '/network', Icon: GlobeIcon, status: 'live' });
  return items;
}

/** Mobile bottom bar: Home, Messages, the first stewarded thing, My Profile (+ "More" in the component). */
export function bottomNav(groups: NavGroup[]): NavItem[] {
  const flat = groups.flatMap((g) => g.items);
  const byId = (id: string) => flat.find((i) => i.id === id);
  // Org/service workspaces have no 'home' item in their nav — still give mobile a way back.
  const home = byId('home') ?? { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' as const };
  const picks = [home, byId('messages'), byId('organization') ?? byId('org-discussions') ?? byId('service-overview'), byId('you')]
    .filter((i): i is NavItem => !!i);
  // Fill remaining slots (4 tabs max) from whatever's left, preserving nav order.
  for (const item of flat) {
    if (picks.length >= 4) break;
    if (!picks.some((p) => p.id === item.id)) picks.push(item);
  }
  return picks.slice(0, 4);
}
