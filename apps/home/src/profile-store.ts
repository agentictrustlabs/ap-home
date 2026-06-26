// @legacy-rpc-pattern (ADR-0044): the home reads/writes the profile by calling the MCP `/mcp` ingress
// directly (RPC-shaped first-party access). The objective is intent-expression to an a2a agent that
// composes the vault primitive; legacy to migrate, not the first-party pattern to extend.
//
// The Impact home's profile store — the member's COMMUNITY CONTACT profile (name/email/phone/org),
// re-used across community apps. spec 278: this is now persisted in the member's PER-PERSON ENCRYPTED
// vault at demo-mcp (the `vault:impact-profile` record, sealed under the member's own GCP Cloud KMS
// KEK), NOT browser localStorage. The home holds no key material and no copy: it reads/writes over the
// same-origin `/mcp-bind` proxy by minting an OAuth token for the logged-in member and calling the
// owner-reads/writes-own `get_impact_profile` / `set_impact_profile` tools. No binding (the member
// hasn't run the connected-custodian ceremony at /vault-key) ⇒ fail-closed (`vault_key_unauthorized`).

import type { Address } from '@agenticprimitives/types';

export interface ImpactContactProfile {
  /** Display name — first/last let community apps render a friendly header like
   *  "Rich Pedersen" instead of the handle. Identity-level; the handle remains the
   *  canonical id. Held at Impact, re-used across every community app. */
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  country?: string;
  city?: string;
  /** For church / organization / network adopters or members — held at Impact because
   *  "the org you're part of" is a community-wide identity fact, not app-specific. */
  organizationName?: string;
  organizationCountry?: string;
}

export interface StoredAttestation {
  docHash: string;
  docId: string;
  signedAt: number;
  consentBoundTo: string;
}

export interface ImpactStoredProfile {
  v: 1;
  contact?: ImpactContactProfile;
  /** Community-wide attestations the member has signed at their home, re-used across
   *  relying apps. WEA Statement of Faith is the canonical example (signed once at
   *  Impact, every faith-aligned community app gets the same attestation receipt). */
  attestations?: {
    wea?: StoredAttestation;
  };
}

export type ImpactProfileFieldKey = keyof ImpactContactProfile;

/** Raised when the member has no vault-key binding yet (must run the /vault-key ceremony first). */
export class VaultKeyUnauthorizedError extends Error {
  constructor() {
    super('vault_key_unauthorized');
    this.name = 'VaultKeyUnauthorizedError';
  }
}

export const PROFILE_FIELDS: { key: ImpactProfileFieldKey; label: string; type: 'email' | 'tel' | 'text'; placeholder: string; help: string }[] = [
  { key: 'firstName',           label: 'First name',            type: 'text',  placeholder: 'Rich',                     help: 'Used to greet you across community apps.' },
  { key: 'lastName',            label: 'Last name',             type: 'text',  placeholder: 'Pedersen',                 help: 'Used together with your first name to render a friendly display name.' },
  { key: 'email',               label: 'Email',                 type: 'email', placeholder: 'you@example.com',          help: 'How community apps reach you. Shared on your terms.' },
  { key: 'phone',               label: 'Phone',                 type: 'tel',   placeholder: '+1 555 0100',              help: 'Optional. Shared only when you explicitly grant the scope.' },
  { key: 'country',             label: 'Country',               type: 'text',  placeholder: 'United States',            help: 'Where you live.' },
  { key: 'city',                label: 'City',                  type: 'text',  placeholder: 'San Francisco',            help: 'Optional. Useful for local-team apps.' },
  { key: 'organizationName',    label: 'Organization name',     type: 'text',  placeholder: 'Grace Community Church',    help: 'If you act on behalf of a church, organization, or network in the community.' },
  { key: 'organizationCountry', label: 'Organization country',  type: 'text',  placeholder: 'United States',            help: 'Where your organization is based.' },
];

// ─── demo-mcp vault access (same-origin /mcp-bind proxy → DEMO_MCP_URL) ──────────────────────
// The open demo authorization endpoint mints an OAuth token bound to the principal's grant bundle
// (itself stored under the principal's KEK — so minting already requires a live binding). The token
// then authorizes owner-reads/writes-own on the /mcp ingress; demo-mcp re-derives the principal from
// the token and gates every op on the per-person vault-key authorization (read/write).

const MCP_BIND = '/mcp-bind';

async function mintToken(principal: Address): Promise<string> {
  const res = await fetch(`${MCP_BIND}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (body.error === 'vault_key_unauthorized') throw new VaultKeyUnauthorizedError();
  if (!res.ok || !body.access_token) throw new Error(`mint failed: ${body.error ?? res.status}`);
  return body.access_token;
}

async function callMcp(token: string, tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${MCP_BIND}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args: args ?? {} }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.error === 'vault_key_unauthorized') throw new VaultKeyUnauthorizedError();
  return body;
}

/** Read the member's encrypted community profile from their vault. Returns an empty profile if the
 *  member has never saved one. Throws `VaultKeyUnauthorizedError` if they haven't activated their
 *  vault key (run the /vault-key ceremony) yet. */
export async function loadImpactProfile(addr: Address): Promise<ImpactStoredProfile> {
  const token = await mintToken(addr);
  const out = await callMcp(token, 'get_impact_profile');
  const record = out.record as ImpactStoredProfile | null | undefined;
  if (record && record.v === 1) return record;
  return { v: 1 };
}

/** Seal the member's community profile into their vault under their own KEK. Throws
 *  `VaultKeyUnauthorizedError` if they haven't activated their vault key yet. */
export async function saveImpactProfile(addr: Address, profile: ImpactStoredProfile): Promise<void> {
  const token = await mintToken(addr);
  const out = await callMcp(token, 'set_impact_profile', { data: profile });
  if (out.ok !== true) throw new Error(`save failed: ${String(out.error ?? 'unknown')}`);
}
