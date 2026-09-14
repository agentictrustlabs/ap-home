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
  /** This row opens a SECOND PANE beside the nav rather than being a destination in itself. One
   *  grammar for every second level: a right caret, a pane, and the row lit for the whole section. */
  opensPane?: PaneId;
  /** Present ⇒ the row is shown but not navigable, and this says why. Reserved for a surface that
   *  genuinely cannot do its job yet — never for permission (a server decides that, not a nav). */
  disabledReason?: string;
}

/** The sections that open a pane. Both are lists too long to hang under a heading in a 240px column,
 *  and both are somewhere you go to work on a set of things rather than a single page. */
export type PaneId = 'stewardship' | 'settings';
export interface NavGroup {
  id?: string;
  heading?: string;
  items: NavItem[];
  /** Draws the ONE hairline that separates "where you take part" from "what it holds and how it is set
   *  up". Uniform 20px gaps between every group carried no grouping information — they just made the
   *  list sparse. */
  startsRegion?: boolean;
  /** An exit, not a region: space above it, no line. */
  isExit?: boolean;
}

/** A pane's groups. Same shape as a nav group, rendered in the second column. */
export type SettingsGroup = { heading: string; items: NavItem[] };


/**
 * spec 348 — ONE nav shape for every agent class.
 *
 * Per-class variation is the PRESENCE OR ABSENCE OF A WHOLE AREA, never a different arrangement of the
 * same items. Before this, the three navs disagreed about where the same thing lived — Trust graph was in
 * Manage for an org and Discovery for a person, a service had no Library because nobody wired one, and
 * `Manage` had become the bucket for nine unrelated things. The shape is now:
 *
 *   top band (4) · Work · ─── · Stewardship → · Records · Attestations · Settings →
 *
 * The test for the top band: you go there to WATCH or TAKE PART. Everything you go to in order to change
 * how the agent behaves is Settings.
 *
 * ONE grammar for every second level (2026-08-31): a section too long to hang under a heading in a 240px
 * column opens a PANE beside the nav — a right caret, the row lit for the whole section, the pane's items
 * as real URLs. Stewardship and Settings both work that way. There is deliberately no accordion: two
 * disclosure patterns in one column meant the same visual said two things, and the collapsed headings
 * cost vertical space to show nothing.
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
  /** Does this workspace COORDINATE PEOPLE? An organization always does. A service agent does when it is
   *  a workspace; a treasury or a registry does not, and an always-empty Members page teaches nothing
   *  (§5's empty rule). The caller knows the agent's kind; the nav should not re-derive it. */
  hasMembers = false,
): NavGroup[] {
  const isPerson = active.kind === 'person';
  const href = (page: string): string => workspaceHref(active, page);
  const backHome: NavGroup = {
    items: [{ id: 'back-home', label: 'Back to your home', href: '/', Icon: HomeIcon, status: 'live' }],
    isExit: true,
  };

  // ── the top band: the same four questions of any agent ────────────────────────────────────────────
  //    what needs me today · who is talking to it · what has it done · what does it hold
  const overviewHref = isPerson ? '/' : active.kind === 'service' ? serviceHref(active.agent) : orgHref(active.org, 'overview');
  // No context heading: it rendered `alice-home-church` as `ALICE-HOME-CHURCH` (a user-supplied name run
  // through a label style), and existed for org/service but not person — so every row shifted 27px when
  // you switched workspace. The topbar switcher already says whose workspace this is, and the Settings
  // pane header repeats it where it is load-bearing (you are about to write to that agent's vault).
  const top: NavGroup = {
    items: [
      // spec 398 §4.1 — the first slot is TODAY (§4.2): decisions · active · finished · next; the status map sits under it.
      { id: 'overview', label: 'Today', href: overviewHref, Icon: isPerson ? HomeIcon : active.kind === 'org' ? BuildingIcon : LandmarkIcon, status: 'live' },
      { id: 'messages', label: 'Messages', href: href('messages'), Icon: ChatIcon, status: 'live', ...(badges.inbox ? { badge: badges.inbox } : {}) },
      // spec 310's control-plane timeline, in the plural because the band is a place.
      { id: 'activities', label: 'Activities', href: href('activities'), Icon: HistoryIcon, status: 'live' },
      { id: 'library', label: 'Library', href: href('library'), Icon: DatabaseIcon, status: 'live' },
    ],
  };

  // An org MEMBER (spec 318) gets participation only. Adding areas must never widen what membership
  // grants — and WHO ELSE BELONGS is something membership already grants: the Ask answers "who are the
  // members of this team" for a member (`organization.membership.list` derives standing and allows it),
  // so hiding the page while the conversation answers the question is two surfaces disagreeing about one
  // model. Deciding who belongs stays steward-only, in Settings → Membership.
  if (active.kind === 'org' && orgRelationship === 'member') {
    return [
      top,
      { items: [
        { id: 'org-discussions', label: 'Discussions', href: orgHref(active.org, 'discussions'), Icon: HashIcon, status: 'live' },
        ...(hasMembers ? [{ id: 'members', label: 'Members', href: href('members'), Icon: UserIcon, status: 'live' as const }] : []),
        // Spec 400 W2 (B4) — every grant the organization issued, one screen, revoke here (its steward's act).
        { id: 'grants', label: 'Grants', href: href('grants'), Icon: ShieldIcon, status: 'live' as const },
        { id: 'work', label: 'Work', href: orgHref(active.org, 'work'), Icon: CheckCircleIcon, status: 'live' as const },
      ] },
      backHome,
    ];
  }

  const groups: NavGroup[] = [top];

  // Discussions is a PARTICIPATION surface (the settings pane configures the replies — spec 348 §2.3).
  if (active.kind === 'org') {
    groups.push({ items: [{ id: 'org-discussions', label: 'Discussions', href: orgHref(active.org, 'discussions'), Icon: HashIcon, status: 'live' }] });
  }

  // Members: WHO IS HERE, beside the other places you take part. Deciding who belongs is a different
  // question and lives in Settings → Membership — looking a colleague up should not put you on a screen
  // of pending applications and invite controls.
  if (hasMembers && active.kind !== 'person') {
    groups.push({ items: [{ id: 'members', label: 'Members', href: href('members'), Icon: UserIcon, status: 'live' }] });
  }

  // ── Work (§2.1b): a participation surface beside the band, not inside it — the four stay four. ────
  if (active.kind !== 'service') {
    groups.push({ items: [{ id: 'work', label: 'Work', href: href('work'), Icon: CheckCircleIcon, status: 'live' }] });
  }

  // ── Stewardship (§2.2): what this agent stewards FOR someone. A service is stewarded, it does not
  //    steward. Collapsed by default — it is a directory, not a destination. ─────────────────────────
  // ── Records + Attestations: their own areas (§2.4/§2.5). ──────────────────────────────────────────
  // Records and Attestations hold ONE item each today, so they render as plain rows (the sidebar folds
  // any area with fewer than two children). The item carries the AREA's noun — `All records` only ever
  // existed to disambiguate from a heading directly above it. When W4 lands the per-family split they
  // become real areas again with no change here.
  groups.push({ items: [
    { id: 'records-all', label: 'Records', href: href('records'), Icon: DatabaseIcon, status: 'live' },
    // spec 398 §6.1 — three stores, never one label: personal facts · workspace knowledge · run context, each in its vault.
    { id: 'memory', label: 'Memory', href: href('memory'), Icon: DatabaseIcon, status: 'live' },
    // agent-vocabulary.md R.3 — YOURS, not stewardship: who you let in (spec 401), every grant you issued (400 B4), your
    // own work by words (400 B5). They used to sit under "You steward", where four of seven items were not stewardship.
    ...(isPerson ? [
      { id: 'contacts', label: 'Contacts', href: '/contacts', Icon: UserIcon, status: 'live' as const },
      { id: 'grants', label: 'Grants', href: '/grants', Icon: ShieldIcon, status: 'live' as const },
      { id: 'search', label: 'Search', href: '/search', Icon: DatabaseIcon, status: 'live' as const },
    ] : []),
  ], startsRegion: true });
  // Attestations: person-only today. A managed agent CAN sign statements, so the area applies in
  // principle — but none has an agent-scoped page yet, and §5 says an empty area renders nothing.
  if (isPerson) {
    groups.push({ items: [
      { id: 'attestations-all', label: 'Attestations', href: '/attestations', Icon: AwardIcon, status: 'live' },
    ] });
  }
  // Trust graph sits with Attestations, not in Settings. It is not a SETTING — nothing on it is
  // configured; it is a view of what other agents have said, which is the same kind of thing an
  // attestation is. Directly above Stewardship, so the three "what others say / what you hold for
  // others" surfaces read as one band.
  groups.push({ items: [
    { id: 'trust-graph', label: 'Trust graph', href: href('trust-graph'), Icon: ShieldIcon, status: 'live' },
  ] });

  // ── Stewardship, then Settings — the two PANES are neighbours at the bottom, so the one second-level
  //    grammar reads as one band: what this agent holds for other people, then how it is set up.
  if (active.kind !== 'service') {
    const first = stewardshipPane(active)[0]?.items[0];
    if (first) {
      groups.push({ items: [{ id: 'stewardship', label: 'Stewardship', href: first.href, Icon: BuildingIcon, status: 'live', opensPane: 'stewardship' }] });
    }
  }

  // Settings LAST: everything above is somewhere you work; this is the door you take when you want to
  // alter the thing you were working in.
  groups.push({ items: [{ id: 'settings', label: 'Settings', href: href('settings'), Icon: SettingsIcon, status: 'live', opensPane: 'settings' }] });

  if (!isPerson) groups.push(backHome);
  return groups.filter((g) => g.items.length > 0);
}

/** spec 348 §2.2 — what this agent stewards FOR someone, in a pane of its own. A service is stewarded;
 *  it does not steward, so it has none. */
export function stewardshipPane(active: WorkspaceScope = { kind: 'person' }): SettingsGroup[] {
  if (active.kind === 'service') return [];
  // ONE destination for the agents themselves, then the surfaces that are ABOUT something other than a
  // class of agent. The four items here used to be four different kinds of thing wearing one heading:
  // a class (Organizations), a role (Treasuries), a relationship (Alliances) — and "Workspaces", which
  // listed an APP's membership organizations and no agent at all, under the same word the substrate uses
  // for a coordinator SA (`.workspace`, spec 344/346). A person reading the list could not tell which
  // axis it was cut on, and the answer was: all of them at once.
  //
  // `Agents` holds every agent you steward, grouped by CLASS (ADR-0046). Treasuries stays because a
  // treasury surface is about money — balances and funding — not about listing a role. Alliances stays
  // because it is about a relationship between organizations. App workspaces moved out of stewardship
  // entirely: you join them, you do not steward them.
  // agent-vocabulary.md R.2/R.3 (2026-09-14): two KINDS, two items. "Agents" as a list name said, to a person, "agents
  // are those other things" — and every participant is an agent, including her. Organizations (org-class: .org .team
  // .workspace .household .church .circle) and Services (.svc .treasury .registry, each with a role) are the two kinds
  // she stewards; the page is one, filtered. Contacts, Grants and Search are NOT stewardship — they are hers — and sit
  // in the person nav's "Yours" band; Alliances is an organization's relation to other organizations and sits in the
  // organization's own pane.
  const items: NavItem[] = active.kind === 'person'
    ? [
        { id: 'organizations', label: 'Organizations', href: '/agents?kind=org', Icon: BuildingIcon, status: 'live' },
        { id: 'services', label: 'Services', href: '/agents?kind=service', Icon: BotIcon, status: 'live' },
        { id: 'treasuries', label: 'Treasuries', href: '/treasuries', Icon: LandmarkIcon, status: 'live' },
        // Spec 363 W4 — the people you live with: a household is an organization-class body you keep (tbox/household.ttl);
        // it sits with what you steward because that is what it is.
        { id: 'household', label: 'Household', href: '/household', Icon: UserIcon, status: 'live' },
      ]
    : [
        { id: 'org-treasury', label: 'Treasuries', href: orgHref(active.org, 'treasury'), Icon: LandmarkIcon, status: 'live' },
        // An alliance is THIS organization's relation to other organizations (spec 341) — the organization's pane, not the person's.
        { id: 'alliances', label: 'Alliances', href: `/alliances?org=${active.org.toLowerCase()}`, Icon: LinkIcon, status: 'live' },
      ];
  return [{ heading: 'You steward', items }];
}

/** The groups a given pane shows — one entry point, so the sidebar never branches on which pane. */
export function paneGroups(
  pane: PaneId,
  active: WorkspaceScope = { kind: 'person' },
  orgRelationship: 'steward' | 'member' = 'steward',
): SettingsGroup[] {
  return pane === 'stewardship' ? stewardshipPane(active) : buildSettingsPane(active, orgRelationship);
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
  /** Does anything in the naming service resolve to this agent? Several surfaces depend on it: a card is
   *  served at an address derived from the NAME, and a directory entry names that card. Shown-but-
   *  disabled rather than hidden — a person should see what becomes available, and why it is not yet. */
  hasName = true,
): SettingsGroup[] {
  if (active.kind === 'org' && orgRelationship === 'member') return [];
  const href = (page: string): string => workspaceHref(active, page);
  const isOrg = active.kind === 'org';
  const isPerson = active.kind === 'person';

  // A nameless agent cannot serve a card (the address comes from the name) and cannot be listed (an entry
  // names a card), so those rows wait — and say what they are waiting for. Naming and Profile stay open,
  // because naming it is the way out.
  const needsName = hasName ? undefined : 'Give this agent a name first — its public address comes from its name.';
  // IDENTITY — who this agent is. Two pages, and the split is real: Profile is the agent's own
  // description; Naming owns the name, its records AND the A2A endpoint (the endpoint was once set inside
  // the card editor because the card needs it, but it is published under the NAME and read by resolution).
  const identity: NavItem[] = [
    { id: 'set-profile', label: 'Profile', href: href('profile'), Icon: UserIcon, status: 'live' },
    { id: 'set-naming', label: 'Naming', href: href('naming'), Icon: TagIcon, status: 'live' },
  ];
  // CAPABILITIES — what this agent can DO. Its own area, not a row under Discovery, because it is the
  // RECORD every other surface projects from (ADR-0051): the card advertises a curated subset of it, the
  // registry ranks on the ids it publishes, ARD restates them. Filing the source under one of its
  // consumers made it look like a discovery setting, which is how a card grew a second, rival editor.
  const capabilities: NavItem[] = [
    { id: 'set-capabilities', label: 'Capabilities', href: href('capabilities'), Icon: AwardIcon, status: 'live' },
  ];
  // DISCOVERY — how this agent is FOUND: the card that advertises what it can do, and the registry that
  // lists the card. Each needs a name, because the card is served at an address derived from it;
  // shown-but-disabled rather than hidden, so a person sees what becomes available and why it is not yet.
  const discovery: NavItem[] = [
    { id: 'set-card', label: 'Agent Card', href: href('card'), Icon: IdCardIcon, status: 'live', ...(needsName ? { disabledReason: needsName } : {}) },
    { id: 'set-registry', label: 'Registry', href: href('registry'), Icon: DatabaseIcon, status: 'live', ...(needsName ? { disabledReason: needsName } : {}) },
  ];
  // REACHABILITY — whether anyone can GET TO this agent, which spec 338 insists is four independent
  // choices (named · listed · resolvable · inbound) and not one switch. It stays available while
  // NAMELESS, because issuing an invitation is exactly how someone reaches an agent with no public name:
  // lacking the first choice does not remove the other three. Person-only today — the other classes have
  // no agent-scoped surface for it yet, and §5 says an empty area renders nothing.
  const reachability: NavItem[] = isPerson ? [
    { id: 'set-visibility', label: 'Visibility', href: '/visibility', Icon: GlobeIcon, status: 'live' },
    { id: 'set-invitations', label: 'Invitations issued', href: '/visibility#invitations', Icon: LinkIcon, status: 'live' },
  ] : [];
  // Behaviour varies by class, and it varies because the SURFACES differ — not to make the pane shorter:
  //   • a service agent has no assistant configuration; its Playbook IS what it answers as, so `Ask`
  //     would point at the same page under a second name;
  //   • only a person's agent has a discussion-reply panel distinct from its assistant. An org's
  //     discussion behaviour is the assistant.
  // An item that would duplicate another is worse than an absent one (§5's empty rule).
  // BEHAVIOUR — how it ACTS, which is not the same question as what it CAN do (that is Capabilities,
  // above): these configure how it responds, not what it is able to offer.
  const behaviour: NavItem[] = [
    ...(active.kind !== 'service' ? [{ id: 'set-ask', label: 'Ask', href: href('ask'), Icon: BotIcon, status: 'live' as const }] : []),
    // NOT "Discussions" — that is the top band, where you take part. This edits the replies.
    ...(isPerson ? [{ id: 'set-discussion', label: 'Discussion replies', href: '/discussion-replies', Icon: HashIcon, status: 'live' as const }] : []),
    { id: 'set-playbook', label: 'Playbook', href: href('playbook'), Icon: CodeIcon, status: 'live' },
    // Coaches (a coaching SERVICE per game, hired under a study grant) is reached from Contacts — a coach is a contact
    // with role `coach` (agent-vocabulary.md D3), not a setting; the page stays at /coaches for the hiring acts.
    // spec 398 G3 — a routine as a product: versioned skill + trigger + fresh authority, with its history.
    { id: 'set-routines', label: 'Routines', href: href('routines'), Icon: HistoryIcon, status: 'live' },
  ];
  const access: NavItem[] = [
    // "Membership", not "Members": the main nav's Members is the roster. This is where a steward decides
    // who gets in and who is removed.
    ...(isOrg ? [{ id: 'set-members', label: 'Membership', href: orgHref(active.org, 'membership'), Icon: UserIcon, status: 'live' as const }] : []),
    // A person's access — their credentials and the delegations they hold — is Security, in the user
    // menu (§4): it is about the signed-in person, not about an agent in a workspace.
    ...(!isPerson ? [{ id: 'set-access', label: 'Access', href: href('access'), Icon: ShieldIcon, status: 'live' as const }] : []),
    // spec 342's lifecycle page, renamed: it answers "is this active", not "how is it configured" —
    // and `Settings` now names the pane.
    ...(isOrg ? [{ id: 'set-status', label: 'Status', href: orgHref(active.org, 'status'), Icon: SettingsIcon, status: 'live' as const }] : []),
  ];

  // Six groups, each answering ONE question about the agent: who it is · what it can do · how it is
  // found · whether it can be reached · how it acts · who may act through it.
  return [
    { heading: 'Identity', items: identity },
    { heading: 'Capabilities', items: capabilities },
    { heading: 'Discovery', items: discovery },
    { heading: 'Reachability', items: reachability },
    { heading: 'Behaviour', items: behaviour },
    { heading: 'Authority', items: access },
  ].filter((g) => g.items.length > 0);
}

/** spec 348 §4 — the topbar user menu: about the signed-in PERSON and the deployment, not about the
 *  agent in this workspace. Network is here rather than per-agent because it is one substrate for every
 *  agent, and a per-agent item for a non-per-agent fact invents a distinction that does not exist. */
export function buildUserMenu(wl: WhiteLabelConfig): NavItem[] {
  const items: NavItem[] = [{ id: 'you', label: 'Your profile', href: '/profile', Icon: UserIcon, status: 'live' }];
  // Household is NOT here: it moved to the Stewardship pane, beside Treasuries and Alliances, because
  // that is where a person looks for the things that are theirs to keep — and a nav item in two places
  // is two answers to "where does this live".
  if (wl.services.devices) items.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  if (wl.services.connectedApps) {
    items.push({ id: 'apps', label: 'Connected', href: '/apps', Icon: LinkIcon, status: 'live' });
    // The membership organizations an app supports for invite / register. NOT `.workspace` agents, and
    // not something you steward — it sits with the apps it belongs to, under the name it actually means.
    items.push({ id: 'workspaces', label: 'App workspaces', href: '/workspaces', Icon: GlobeIcon, status: 'live' });
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
