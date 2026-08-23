// Portal navigation, derived from the white-label config (manageableAgents drives the
// "Your agents" group + live/soon status) AND the active workspace (spec 315): the left nav
// is always scoped to what the header switcher selected — person / org / connected app.
import type { WhiteLabelConfig } from '../../whitelabel/schema';
import type { WorkspaceScope } from '../../lib/workspace';
import { orgHref, serviceHref } from '../../lib/workspace';
import {
  UserIcon, BuildingIcon, LandmarkIcon, DatabaseIcon, TagIcon, AwardIcon, LinkIcon, ShieldIcon, HistoryIcon, HomeIcon,
  ChatIcon, HashIcon, GlobeIcon, BotIcon, CheckCircleIcon, SettingsIcon, CodeIcon,
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
  heading?: string;
  items: NavItem[];
}

const AGENT_META: Record<string, { href: string; Icon: IconComponent }> = {
  person: { href: '/you', Icon: UserIcon },
  organization: { href: '/organizations', Icon: BuildingIcon },
  treasury: { href: '/treasuries', Icon: LandmarkIcon },
  'data-source': { href: '/data-sources', Icon: DatabaseIcon },
};

export function buildNav(
  wl: WhiteLabelConfig,
  badges: { apps?: number; inbox?: number } = {},
  active: WorkspaceScope = { kind: 'person' },
  // spec 318: 'member' = authority-only — the nav shows ONLY the surfaces membership grants
  // (channels); the custody surfaces (overview/data/treasury/org inbox) are steward-only and their
  // servers re-verify control anyway (defense in depth, never nav-only).
  orgRelationship: 'steward' | 'member' = 'steward',
  /** Display name of the active org/service workspace — headed into the sidebar so you always know where you are. */
  workspaceName?: string,
): NavGroup[] {
  // Every non-person workspace ends with an explicit way back — the switcher alone
  // (small topbar control) was the only exit, which made org workspaces feel like dead ends.
  const backHome: NavGroup = {
    items: [{ id: 'back-home', label: 'Back to your home', href: '/', Icon: HomeIcon, status: 'live' }],
  };

  // Every workspace reads the same way: the agent's LIVE surfaces first, then a "Manage" band whose
  // items ARE the settings/config sections (real routes, not a hidden tabbed page) — one mental model
  // across person / org / service.

  // ORG workspace (spec 315): URL-scoped under /org/<sa>/….
  if (active.kind === 'org') {
    const a = active.org;
    if (orgRelationship === 'member') {
      return [
        {
          heading: workspaceName ?? 'Organization',
          items: [
            { id: 'org-discussions', label: 'Discussions', href: orgHref(a, 'discussions'), Icon: HashIcon, status: 'live' },
            // spec 334 §6/§12 — members see open endeavors + their own participations.
            { id: 'org-work', label: 'Work', href: orgHref(a, 'work'), Icon: CheckCircleIcon, status: 'live' },
          ],
        },
        backHome,
      ];
    }
    return [
      {
        heading: workspaceName ?? 'Organization',
        items: [
          { id: 'org-overview', label: 'Overview', href: orgHref(a, 'overview'), Icon: BuildingIcon, status: 'live' },
          { id: 'org-messages', label: 'Messages', href: orgHref(a, 'messages'), Icon: ChatIcon, status: 'live' },
          { id: 'org-discussions', label: 'Discussions', href: orgHref(a, 'discussions'), Icon: HashIcon, status: 'live' },
          // spec 334 §6 — Requests/Triage, Endeavor list/board, Endeavor detail, New request.
          { id: 'org-work', label: 'Work', href: orgHref(a, 'work'), Icon: CheckCircleIcon, status: 'live' },
          // Library sits in the TOP org area (mirrors the person nav's top-group Library), not buried in Manage.
          { id: 'org-library', label: 'Library', href: orgHref(a, 'library'), Icon: DatabaseIcon, status: 'live' },
        ],
      },
      // Manage: the old scrolling "Data" page split into its real pieces (spec 315) + Treasury.
      {
        heading: 'Manage',
        items: [
          { id: 'org-profile', label: 'Profile', href: orgHref(a, 'profile'), Icon: BuildingIcon, status: 'live' },
          // Agent: the org's discussion bot ("Manage Bot" — auto-reply + member routing) + the org
          // Playbook that shapes every discussion reply. Mirrors the person Manage → Agent tab.
          { id: 'org-agent', label: 'Agent', href: orgHref(a, 'agent'), Icon: BotIcon, status: 'live' },
          { id: 'org-members', label: 'Members', href: orgHref(a, 'members'), Icon: UserIcon, status: 'live' },
          { id: 'org-records', label: 'Records', href: orgHref(a, 'records'), Icon: DatabaseIcon, status: 'live' },
          { id: 'org-access', label: 'Access', href: orgHref(a, 'access'), Icon: ShieldIcon, status: 'live' },
          { id: 'org-trust-graph', label: 'Trust graph', href: orgHref(a, 'trust-graph'), Icon: ShieldIcon, status: 'live' },
          { id: 'org-treasury', label: 'Treasury', href: orgHref(a, 'treasury'), Icon: LandmarkIcon, status: 'live' },
          // spec 342 — the org's lifecycle: activate / deactivate / delete. Last in the band because
          // it is where an organization is put aside, and steward-only by construction (the Manage
          // band never renders for members, and the write needs the stewardship delegation anyway).
          { id: 'org-settings', label: 'Settings', href: orgHref(a, 'settings'), Icon: SettingsIcon, status: 'live' },
        ],
      },
      backHome,
    ];
  }
  // SERVICE workspace (ADR-0046): one custodial service-class agent. Same mental model as
  // org — live surfaces, then Manage — so a workspace (Gather27 roster, treasury, …) is
  // something you can actually work in, not a dead overview card.
  if (active.kind === 'service') {
    const a = active.agent;
    return [
      {
        heading: workspaceName ?? 'Service',
        items: [
          { id: 'service-overview', label: 'Overview', href: serviceHref(a), Icon: LandmarkIcon, status: 'live' },
          { id: 'service-messages', label: 'Messages', href: serviceHref(a, 'messages'), Icon: ChatIcon, status: 'live' },
        ],
      },
      {
        heading: 'Manage',
        items: [
          { id: 'service-records', label: 'Records', href: serviceHref(a, 'records'), Icon: DatabaseIcon, status: 'live' },
          { id: 'service-access', label: 'Access', href: serviceHref(a, 'access'), Icon: ShieldIcon, status: 'live' },
        ],
      },
      backHome,
    ];
  }

  // ── PERSON (your home) ──────────────────────────────────────────────────────────────────────────
  const agents = wl.manageableAgents;
  const person = agents.find((a) => a.id === 'person');
  // "Data sources · Soon" removed — it was placeholder noise in the steward list.
  const others = agents.filter((a) => a.id !== 'person' && a.id !== 'data-source');

  const top: NavItem[] = [
    { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' },
    { id: 'messages', label: 'Messages', href: '/messages', Icon: ChatIcon, status: 'live', badge: badges.inbox },
    // spec 334 §7 — the person's own coordination facts (allocations awaiting
    // commitment, active commitments, pending decisions) + the New request composer.
    { id: 'my-work', label: 'My Work', href: '/work', Icon: CheckCircleIcon, status: 'live' },
    { id: 'library', label: 'Library', href: '/library', Icon: DatabaseIcon, status: 'live' },
  ];

  const yourAgents: NavItem[] = others.map((a) => ({
    id: a.id,
    label: a.label,
    href: AGENT_META[a.id]?.href ?? `/${a.id}`,
    Icon: AGENT_META[a.id]?.Icon ?? BuildingIcon,
    status: a.status,
  }));
  // Alliances (uupg interop, ported from the GC impact home): orgs you steward that HOST a coalition —
  // an org-with-purpose fact, so it lives beside the other stewarded things, not in whitelabel agents.
  yourAgents.push({ id: 'alliances', label: 'Alliances', href: '/alliances', Icon: LinkIcon, status: 'live' });
  // App Workspaces (Gather27 first): invite/register listings of membership organizations.
  yourAgents.push({ id: 'workspaces', label: 'Workspaces', href: '/workspaces', Icon: GlobeIcon, status: 'live' });

  // Discovery: how you and your agents are found + described.
  const discovery: NavItem[] = [
    { id: 'registry', label: 'Registry', href: '/registry', Icon: DatabaseIcon, status: 'live' },
    { id: 'naming', label: 'Naming', href: '/naming', Icon: TagIcon, status: 'live' },
    // id + href stay `skills` — they are legacy route/state keys (ADR-0051 prose/key split); the LABEL is
    // the canonical user-facing term for the declared capability projection (facet-registries.md §7).
    { id: 'skills', label: 'Capabilities', href: '/skills', Icon: AwardIcon, status: 'live' },
    // Trust web (impact port): who holds keys vs who granted authority — the person's live graph.
    { id: 'trust-graph', label: 'Trust graph', href: '/trust-graph', Icon: ShieldIcon, status: 'live' },
    // Live backend status (impact port): a2a/mcp health, chain head, the on-chain contract registry.
    { id: 'network', label: 'Network', href: '/network', Icon: GlobeIcon, status: 'live' },
  ];

  // Manage (was "Account"): the /you tab content merged into real left items — Profile (personal +
  // identity), Security (devices + delegations + vault key + sign-in), Connected (apps + how you're
  // published). ONE place for each; no "My Profile page with its own tab strip".
  const manage: NavItem[] = [];
  if (person) {
    manage.push({ id: 'you', label: 'Profile', href: '/you', Icon: UserIcon, status: person.status });
    // Agent (spec 328 UX v2): the person's message bot + playbooks — config that used to
    // hide behind the Messages ⚙ dialog.
    manage.push({ id: 'agent', label: 'Agent', href: '/agent', Icon: BotIcon, status: 'live' });
    // Unified metadata editor (docs/architecture/agent-metadata-tiers.md): all three tiers, one page.
    manage.push({ id: 'metadata', label: 'Metadata', href: '/metadata', Icon: TagIcon, status: 'live' });
    // Records: what's in YOUR vault (the person's own analog of the org Records page).
    manage.push({ id: 'records', label: 'Records', href: '/records', Icon: DatabaseIcon, status: 'live' });
    // Visibility (spec 338 §20): who can find this agent — naming/listing/resolution/inbound as four
    // separate choices — plus issued invitations and the recipient-side invitation check.
    manage.push({ id: 'visibility', label: 'Visibility', href: '/visibility', Icon: GlobeIcon, status: 'live' });
  }
  if (wl.services.devices) {
    manage.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  }
  if (wl.services.connectedApps) {
    manage.push({ id: 'apps', label: 'Connected', href: '/apps', Icon: LinkIcon, status: 'live', badge: badges.apps });
    // The other side of Connected: apps you BUILT. Registering one is what lets your own app send
    // people here to sign in — and it is a member decision, not a deployment one (spec 230 §6).
    manage.push({ id: 'developer', label: 'Your apps', href: '/developer', Icon: CodeIcon, status: 'live' });
  }

  // Activity: the record of what you've asserted + what your agents have done — attestations + the
  // audit timeline. Its own major band (spec 315).
  const activity: NavItem[] = [
    { id: 'attestations', label: 'Attestations', href: '/attestations', Icon: AwardIcon, status: 'live' },
    { id: 'activity', label: 'Activity', href: '/activity', Icon: HistoryIcon, status: 'live' },
  ];

  return [
    { items: top },
    { heading: 'You steward', items: yourAgents },
    { heading: 'Discovery', items: discovery },
    { heading: 'Manage', items: manage },
    { heading: 'Activity', items: activity },
  ].filter((g) => g.items.length > 0);
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
