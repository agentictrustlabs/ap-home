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
): NavGroup[] {
  // ORG workspace (spec 315): the left nav is that org's actions, URL-scoped under /org/<sa>/….
  if (active.kind === 'org') {
    const a = active.org;
    return [
      {
        heading: 'Organization',
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
        ],
      },
    ];
  }
  // SERVICE workspace (ADR-0046): one custodial service-class agent's actions. Role-agnostic —
  // treasuries today; any future service role joins here with zero IA change.
  if (active.kind === 'service') {
    return [
      {
        heading: 'Service',
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
    ];
  }

  const agents = wl.manageableAgents;
  const person = agents.find((a) => a.id === 'person');
  const others = agents.filter((a) => a.id !== 'person');

  const top: NavItem[] = [];
  if (person) {
    top.push({ id: 'you', label: 'You', href: '/you', Icon: UserIcon, status: person.status });
  }

  const yourAgents: NavItem[] = others.map((a) => ({
    id: a.id,
    label: a.label,
    href: AGENT_META[a.id]?.href ?? `/${a.id}`,
    Icon: AGENT_META[a.id]?.Icon ?? BuildingIcon,
    status: a.status,
  }));

  // Interactions (spec 313 v2): ONE Messages surface (requests + chats +
  // search/compose — Telegram model); Channels = communities, Networks = org
  // presence. The old /inbox /chats /find routes redirect to /messages.
  const interactions: NavItem[] = [
    { id: 'messages', label: 'Messages', href: '/messages', Icon: ChatIcon, status: 'live', badge: badges.inbox },
    { id: 'channels', label: 'Channels', href: '/channels', Icon: HashIcon, status: 'live' },
    { id: 'networks', label: 'Networks', href: '/networks', Icon: GlobeIcon, status: 'live' },
  ];

  const portal: NavItem[] = [];
  if (wl.services.connectedApps) {
    portal.push({ id: 'apps', label: 'Connected Apps', href: '/apps', Icon: LinkIcon, status: 'live', badge: badges.apps });
  }
  if (wl.services.devices) {
    portal.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  }
  // Discovery registry (spec 279): every named agent + its registration; register named agents into it.
  portal.push({ id: 'registry', label: 'Registry', href: '/registry', Icon: DatabaseIcon, status: 'live' });
  // Agent Naming Service (spec 280): manage the names you steward + publish opt-in connection bootstrap.
  portal.push({ id: 'naming', label: 'Naming Service', href: '/naming', Icon: TagIcon, status: 'live' });
  // Skills (spec 282): manage skills privately + assert a public subset for discovery.
  portal.push({ id: 'skills', label: 'Skills', href: '/skills', Icon: AwardIcon, status: 'live' });
  // Control-plane timeline (spec 310 W4) — audit-backed grant/agent/inbox/manifest events.
  portal.push({ id: 'activity', label: 'Activity', href: '/activity', Icon: HistoryIcon, status: 'live' });

  return [
    { items: top },
    { heading: 'Interactions', items: interactions },
    { heading: 'What you steward', items: yourAgents },
    { heading: 'Your home', items: portal },
  ].filter((g) => g.items.length > 0);
}

/** Flat 5-item set for the mobile bottom bar: Home + the first four live-ish destinations. */
export function bottomNav(groups: NavGroup[]): NavItem[] {
  const flat = groups.flatMap((g) => g.items);
  const home: NavItem = { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' };
  return [home, ...flat].slice(0, 5);
}
