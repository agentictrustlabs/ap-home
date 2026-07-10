// Portal navigation, derived from the white-label config (manageableAgents drives the
// "Your agents" group + live/soon status) AND the active workspace (spec 315): the left nav
// is always scoped to what the header switcher selected — person / org / connected app.
import type { WhiteLabelConfig } from '../../whitelabel/schema';
import type { WorkspaceScope } from '../../lib/workspace';
import { orgHref, serviceHref } from '../../lib/workspace';
import {
  UserIcon, BuildingIcon, LandmarkIcon, DatabaseIcon, TagIcon, AwardIcon, LinkIcon, ShieldIcon, HistoryIcon, HomeIcon,
  ChatIcon, HashIcon, GlobeIcon,
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

  // ORG workspace (spec 315): the left nav is that org's actions, URL-scoped under /org/<sa>/….
  if (active.kind === 'org') {
    const a = active.org;
    if (orgRelationship === 'member') {
      return [
        {
          heading: workspaceName ?? 'Organization',
          items: [
            { id: 'org-channels', label: 'Channels', href: orgHref(a, 'channels'), Icon: HashIcon, status: 'live' },
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
          { id: 'org-data', label: 'Data', href: orgHref(a, 'data'), Icon: DatabaseIcon, status: 'live' },
          { id: 'org-treasury', label: 'Treasury', href: orgHref(a, 'treasury'), Icon: LandmarkIcon, status: 'live' },
        ],
      },
      // Messages sent TO this org's agent (spec 313/315) — the person reads the org inbox because they
      // control it (server re-verifies via managed-agents). Channels/Networks follow the same pattern.
      {
        heading: 'Interactions',
        items: [
          { id: 'org-messages', label: 'Messages', href: orgHref(a, 'messages'), Icon: ChatIcon, status: 'live' },
          // Topic channels INSIDE this org (spec 318 demo realization): communityId = the org SA;
          // membership = a self-signed directory listing in the org's community (ADR-0025 opt-in).
          { id: 'org-channels', label: 'Channels', href: orgHref(a, 'channels'), Icon: HashIcon, status: 'live' },
        ],
      },
      backHome,
    ];
  }
  // SERVICE workspace (ADR-0046): one custodial service-class agent's actions. Role-agnostic —
  // treasuries today; any future service role joins here with zero IA change.
  if (active.kind === 'service') {
    return [
      {
        heading: workspaceName ?? 'Service',
        items: [
          { id: 'service-overview', label: 'Overview', href: serviceHref(active.agent), Icon: LandmarkIcon, status: 'live' },
        ],
      },
      // Messages sent TO this service agent (spec 313/315), read by the managing person (server-verified).
      {
        heading: 'Interactions',
        items: [
          { id: 'service-messages', label: 'Messages', href: `${serviceHref(active.agent)}/messages`, Icon: ChatIcon, status: 'live' },
        ],
      },
      backHome,
    ];
  }

  const agents = wl.manageableAgents;
  const person = agents.find((a) => a.id === 'person');
  const others = agents.filter((a) => a.id !== 'person');

  // Top-level destinations — Home first (the dashboard was previously only reachable
  // via the brand logo), then the single Messages surface (spec 313 v2 — requests +
  // chats + search/compose, Telegram model). Channels/Networks are ORG-workspace
  // surfaces (spec 318) and appear only when an org agent is selected.
  const top: NavItem[] = [
    { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' },
    { id: 'messages', label: 'Messages', href: '/messages', Icon: ChatIcon, status: 'live', badge: badges.inbox },
  ];

  const yourAgents: NavItem[] = others.map((a) => ({
    id: a.id,
    label: a.label,
    href: AGENT_META[a.id]?.href ?? `/${a.id}`,
    Icon: AGENT_META[a.id]?.Icon ?? BuildingIcon,
    status: a.status,
  }));

  // Agent-network tools: how you and your agents are found and described.
  const network: NavItem[] = [
    // Discovery registry (spec 279): every named agent + its registration.
    { id: 'registry', label: 'Registry', href: '/registry', Icon: DatabaseIcon, status: 'live' },
    // Agent Naming Service (spec 280): manage the names you steward.
    { id: 'naming', label: 'Naming Service', href: '/naming', Icon: TagIcon, status: 'live' },
    // Skills (spec 282): manage skills privately + assert a public subset for discovery.
    { id: 'skills', label: 'Skills', href: '/skills', Icon: AwardIcon, status: 'live' },
  ];

  // Account: you, your access, and your audit trail — settings-shaped surfaces last,
  // mirroring how GitHub/Linear/Discord anchor profile+settings at the nav's end.
  const account: NavItem[] = [];
  if (person) {
    account.push({ id: 'you', label: 'My Profile', href: '/you', Icon: UserIcon, status: person.status });
  }
  if (wl.services.connectedApps) {
    account.push({ id: 'apps', label: 'Connected Apps', href: '/apps', Icon: LinkIcon, status: 'live', badge: badges.apps });
  }
  if (wl.services.devices) {
    account.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  }
  // Control-plane timeline (spec 310 W4) — audit-backed grant/agent/inbox/manifest events.
  account.push({ id: 'activity', label: 'Activity', href: '/activity', Icon: HistoryIcon, status: 'live' });

  return [
    { items: top },
    { heading: 'You steward', items: yourAgents },
    { heading: 'Agent network', items: network },
    { heading: 'Account', items: account },
  ].filter((g) => g.items.length > 0);
}

/** Mobile bottom bar: Home, Messages, the first stewarded thing, My Profile (+ "More" in the component). */
export function bottomNav(groups: NavGroup[]): NavItem[] {
  const flat = groups.flatMap((g) => g.items);
  const byId = (id: string) => flat.find((i) => i.id === id);
  // Org/service workspaces have no 'home' item in their nav — still give mobile a way back.
  const home = byId('home') ?? { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' as const };
  const picks = [home, byId('messages'), byId('organization') ?? byId('org-channels') ?? byId('service-overview'), byId('you')]
    .filter((i): i is NavItem => !!i);
  // Fill remaining slots (4 tabs max) from whatever's left, preserving nav order.
  for (const item of flat) {
    if (picks.length >= 4) break;
    if (!picks.some((p) => p.id === item.id)) picks.push(item);
  }
  return picks.slice(0, 4);
}
