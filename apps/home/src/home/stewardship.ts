// The home as a stewardship hub: the things a member helps oversee / manage / protect.
// Sourced from the white-label config (manageableAgents) and exposed as the domain `Steward`
// model the dashboard + nav render from — so adding a real org/treasury later is "a thing you
// steward," not an ad-hoc UI section.
import { whitelabel } from '../whitelabel/config';
import type { Steward } from './types';

/** Everything the member stewards from their home (person first, then what they help steward). */
export function stewardship(): Steward[] {
  return whitelabel.manageableAgents.map((a) => ({
    kind: a.id,
    label: a.label,
    verb: a.verb,
    blurb: a.blurb,
    status: a.status,
  }));
}

/** The things the member HELPS steward (everything except their own person home). */
export function stewardedThings(): Steward[] {
  return stewardship().filter((s) => s.kind !== 'person');
}
