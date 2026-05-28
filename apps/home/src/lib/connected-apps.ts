// A LOCAL mirror of the permissions this home has given, keyed by home address. The canonical
// record lives on-chain / at the app; this lets the Connected Apps section show what the
// member granted FROM this home on this browser (surfaced honestly as such, not a complete
// authority list). The shape is the domain `Permission` (src/home/types).
import type { Address } from '@agenticprimitives/types';
import type { Permission } from '../home/types';

const key = (home: Address) => `agenticprimitives:demo-sso:permissions:${home.toLowerCase()}`;

export function recordConnectedApp(home: Address, grant: Permission): void {
  try {
    const list = listConnectedApps(home).filter((p) => p.clientId !== grant.clientId);
    list.unshift(grant);
    localStorage.setItem(key(home), JSON.stringify(list));
  } catch {
    /* storage blocked — Connected Apps just won't reflect this grant locally */
  }
}

export function listConnectedApps(home: Address): Permission[] {
  try {
    const raw = localStorage.getItem(key(home));
    return raw ? (JSON.parse(raw) as Permission[]) : [];
  } catch {
    return [];
  }
}
