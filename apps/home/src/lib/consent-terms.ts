// WHAT AN ALLOW AGREES TO (spec 445 §4) — one object, computed from the registry, by one function.
//
// The consent sheet renders its lines from this object and /oidc/grant stores this object, so what the person read and
// what a later sign-in is compared against are the same thing by construction, not two lists kept in step. Pure: no
// storage, no chain. The server decides with it (/oidc/remembered); the page only draws it.
import { keccak256, toHex } from 'viem';
import { decodeTimestampTerms } from '@agenticprimitives/delegation';
import type { RelyingApp } from '../whitelabel/schema';
import { sharesEmailClaim } from '../whitelabel/provisioning';
import { grantsCoinAtConnect, sharesProfileName, withEmailClaimConsent, withProfileNameConsent } from './new-member';

export const REMEMBERED_TEMPLATES = ['site-login', 'ask-as-me'] as const;
export type RememberedTemplate = (typeof REMEMBERED_TEMPLATES)[number];
export const isRememberedTemplate = (t: string | undefined): t is RememberedTemplate => t === 'site-login' || t === 'ask-as-me';

export interface SelfVaultTerms { server: string; resources: string[]; ops: string[] }

export interface ConsentTermsV1 {
  v: 1;
  clientId: string;
  template: string;
  /** The registered keys the wires name. `site` is the main wire's delegate (under `ask-as-me`, that is the ask key). */
  delegates: { site: string; ask?: string };
  claims: { name: boolean; email: boolean };
  /** An ask-as-me wire: the template itself, or one minted beside a plain sign-in (`ask_with_login`). */
  ask: boolean;
  readGrant: string[];
  libraryFolders: string[];
  selfVault: SelfVaultTerms | null;
}

const sorted = (xs: readonly string[] | undefined): string[] => [...(xs ?? [])].sort();
const low = (s: string): string => s.toLowerCase();

export function termsFor(client: RelyingApp, template: string): ConsentTermsV1 {
  const plain = template === 'site-login';
  const askBeside = plain && !!client.ask_with_login && !!client.ask_delegate;
  const main = template === 'ask-as-me' && client.ask_delegate ? client.ask_delegate : client.delegate;
  return {
    v: 1,
    clientId: client.client_id,
    template,
    delegates: { site: low(main), ...(askBeside ? { ask: low(client.ask_delegate!) } : {}) },
    claims: { name: sharesProfileName(client), email: sharesEmailClaim(client) },
    ask: askBeside || template === 'ask-as-me',
    readGrant: sorted(client.read_grant?.resources),
    libraryFolders: sorted(client.libraryFolders),
    selfVault: plain && client.self_vault_grant
      ? { server: client.self_vault_grant.server, resources: sorted(client.self_vault_grant.resources), ops: sorted(client.self_vault_grant.ops) }
      : null,
  };
}

const subset = (a: readonly string[], b: readonly string[]): boolean => a.every((x) => b.includes(x));

/** "Asks for nothing more" (spec 445 §5.2, check 9): `now` is covered when it names the same keys and every thing it
 *  asks for was agreed. Asking for less is covered; one thing more is not. */
export function covers(stored: ConsentTermsV1, now: ConsentTermsV1): boolean {
  if (stored.clientId !== now.clientId || stored.template !== now.template) return false;
  if (low(stored.delegates.site) !== low(now.delegates.site)) return false;
  if (now.delegates.ask && low(stored.delegates.ask ?? '') !== low(now.delegates.ask)) return false;
  if (now.claims.name && !stored.claims.name) return false;
  if (now.claims.email && !stored.claims.email) return false;
  if (now.ask && !stored.ask) return false;
  if (!subset(now.readGrant, stored.readGrant)) return false;
  if (!subset(now.libraryFolders, stored.libraryFolders)) return false;
  if (now.selfVault) {
    const s = stored.selfVault;
    if (!s || s.server !== now.selfVault.server) return false;
    if (!subset(now.selfVault.resources, s.resources) || !subset(now.selfVault.ops, s.ops)) return false;
  }
  return true;
}

/** Field order cannot change the digest: the object is written with sorted keys. */
export function termsDigest(terms: ConsentTermsV1): `0x${string}` {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
    : v;
  return keccak256(toHex(JSON.stringify(canon(terms))));
}

/** Registered to mint money authority in the plain sign-in: a charge is never re-issued without a sheet. */
export function mintsPaymentAtSignIn(client: RelyingApp): boolean {
  return !!client.paymentConfig || grantsCoinAtConnect(client);
}

export interface ConsentLines { canDo: string[]; cannotDo: string[]; expiryDays?: number }

const ASK_LINE = 'Ask your agent questions as you. Anything it would do still waits for your signature';
const readLine = (resources: readonly string[]): string =>
  `Read ${resources.includes('vault:impact-profile') && resources.length === 1 ? 'your profile' : `these records of yours: ${resources.map((r) => r.replace(/^vault:/, '')).join(', ')}`}`;

/** The lines the sheet shows, drawn from the terms. The template's own lines stand; each thing the terms add is said. */
export function consentLinesFor<T extends ConsentLines>(base: T, terms: ConsentTermsV1): T {
  let t = withEmailClaimConsent(
    withProfileNameConsent(base, terms.claims.name ? { allowed_scopes: ['profile'] } : null),
    terms.claims.email ? { idTokenClaims: ['email'] } : null,
  );
  const add = (line: string) => { if (!t.canDo.includes(line)) t = { ...t, canDo: [...t.canDo, line] }; };
  if (terms.ask && terms.template !== 'ask-as-me') add(ASK_LINE);
  if (terms.readGrant.length) add(readLine(terms.readGrant));
  return t;
}

/** The lines `now` shows that `stored` did not: what "<App> is asking for more" marks as new. */
export function addedLines<T extends ConsentLines>(base: T, stored: ConsentTermsV1, now: ConsentTermsV1): string[] {
  const was = consentLinesFor(base, stored).canDo;
  return consentLinesFor(base, now).canDo.filter((l) => !was.includes(l));
}

/** When a wire's timestamp caveat ends, in ms; null when it has none. Read with the package's own decoder: the terms
 *  are `abi.encode(uint256 validAfter, uint256 validUntil)`. Unreadable terms answer 0 (already over), never "no expiry". */
export function wireValidUntil(
  wire: { caveats?: Array<{ enforcer: string; terms: string }> } | null | undefined,
  timestampEnforcer: string | undefined,
): number | null {
  const c = (wire?.caveats ?? []).find((x) => timestampEnforcer && low(x.enforcer) === low(timestampEnforcer));
  if (!c) return null;
  try {
    const { validUntil } = decodeTimestampTerms(c.terms as `0x${string}`);
    return Number(validUntil) * 1000;
  } catch {
    return 0;
  }
}
