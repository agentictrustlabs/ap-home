// Portal navigation, derived from the white-label config (manageableAgents drives the
// "Your agents" group + live/soon status). Generic structure; the vertical decides which
// agent kinds appear and whether they're live. Imported only by the shell (PortalShell).
import type { WhiteLabelConfig } from '../../whitelabel/schema';
import {
  UserIcon, BuildingIcon, LandmarkIcon, DatabaseIcon, LinkIcon, ShieldIcon, HistoryIcon, HomeIcon,
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

export function buildNav(wl: WhiteLabelConfig, badges: { apps?: number } = {}): NavGroup[] {
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

  const portal: NavItem[] = [];
  if (wl.services.connectedApps) {
    portal.push({ id: 'apps', label: 'Connected Apps', href: '/apps', Icon: LinkIcon, status: 'live', badge: badges.apps });
  }
  if (wl.services.devices) {
    portal.push({ id: 'security', label: 'Security', href: '/security', Icon: ShieldIcon, status: 'live' });
  }
  portal.push({ id: 'activity', label: 'Activity', href: '/activity', Icon: HistoryIcon, status: 'soon' });

  return [
    { items: top },
    { heading: 'Your agents', items: yourAgents },
    { heading: 'Portal', items: portal },
  ].filter((g) => g.items.length > 0);
}

/** Flat 5-item set for the mobile bottom bar: Home + the first four live-ish destinations. */
export function bottomNav(groups: NavGroup[]): NavItem[] {
  const flat = groups.flatMap((g) => g.items);
  const home: NavItem = { id: 'home', label: 'Home', href: '/', Icon: HomeIcon, status: 'live' };
  return [home, ...flat].slice(0, 5);
}
