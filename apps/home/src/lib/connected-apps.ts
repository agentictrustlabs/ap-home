// A LOCAL mirror of the site delegations this portal has issued, keyed by agent address.
// The canonical record lives on-chain / at the relying app; this lets the Connected Apps
// section show {app, can/cannot, granted, expiry} for grants made FROM this portal on this
// browser. Surfaced honestly in the UI as such (not a complete authority list).
import type { Address } from '@agenticprimitives/types';

export interface ConnectedAppRecord {
  clientId: string;
  appName: string;
  appDomain: string;
  logo?: string;
  canDo: string[];
  cannotDo: string[];
  grantedAt: number;
  expiresAt?: number;
}

const key = (agent: Address) => `agenticprimitives:demo-sso:connected-apps:${agent.toLowerCase()}`;

export function recordConnectedApp(agent: Address, rec: ConnectedAppRecord): void {
  try {
    const list = listConnectedApps(agent).filter((a) => a.clientId !== rec.clientId);
    list.unshift(rec);
    localStorage.setItem(key(agent), JSON.stringify(list));
  } catch {
    /* storage blocked — Connected Apps just won't reflect this grant locally */
  }
}

export function listConnectedApps(agent: Address): ConnectedAppRecord[] {
  try {
    const raw = localStorage.getItem(key(agent));
    return raw ? (JSON.parse(raw) as ConnectedAppRecord[]) : [];
  } catch {
    return [];
  }
}
