// The Impact home's profile store (the member's vault, demo-grade). Keyed on the agent
// address so it's stable across sessions and across sign-in methods. Community-wide
// profile fields — relying apps query via the delegation and may request the member fill
// in missing fields at /profile. In production this becomes a backend MCP that only the
// member's home credentials can open; for the prototype it's localStorage at the home
// origin (`<name>.impact-agent.me`).

import type { Address } from '@agenticprimitives/types';

export interface ImpactContactProfile {
  email?: string;
  phone?: string;
  country?: string;
  city?: string;
  /** For church / organization / network adopters or members — held at Impact because
   *  "the org you're part of" is a community-wide identity fact, not app-specific. */
  organizationName?: string;
  organizationCountry?: string;
}

export interface ImpactStoredProfile {
  v: 1;
  contact?: ImpactContactProfile;
}

export type ImpactProfileFieldKey = keyof ImpactContactProfile;

export const PROFILE_FIELDS: { key: ImpactProfileFieldKey; label: string; type: 'email' | 'tel' | 'text'; placeholder: string; help: string }[] = [
  { key: 'email',               label: 'Email',                 type: 'email', placeholder: 'you@example.com',          help: 'How community apps reach you. Shared on your terms.' },
  { key: 'phone',               label: 'Phone',                 type: 'tel',   placeholder: '+1 555 0100',              help: 'Optional. Shared only when you explicitly grant the scope.' },
  { key: 'country',             label: 'Country',               type: 'text',  placeholder: 'United States',            help: 'Where you live.' },
  { key: 'city',                label: 'City',                  type: 'text',  placeholder: 'San Francisco',            help: 'Optional. Useful for local-team apps.' },
  { key: 'organizationName',    label: 'Organization name',     type: 'text',  placeholder: 'Grace Community Church',    help: 'If you act on behalf of a church, organization, or network in the community.' },
  { key: 'organizationCountry', label: 'Organization country',  type: 'text',  placeholder: 'United States',            help: 'Where your organization is based.' },
];

const KEY = (addr: Address): string => `agenticprimitives:impact-profile:${addr.toLowerCase()}`;

export function loadImpactProfile(addr: Address): ImpactStoredProfile {
  try {
    const raw = localStorage.getItem(KEY(addr));
    if (raw) {
      const p = JSON.parse(raw) as ImpactStoredProfile;
      if (p?.v === 1) return p;
    }
  } catch {
    /* ignore */
  }
  return { v: 1 };
}

export function saveImpactProfile(addr: Address, profile: ImpactStoredProfile): void {
  try {
    localStorage.setItem(KEY(addr), JSON.stringify(profile));
  } catch {
    /* ignore */
  }
}
