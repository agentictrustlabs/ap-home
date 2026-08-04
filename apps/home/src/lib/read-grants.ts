// PER-APP READ GRANTS — one scoped delegation per relying app (spec 341 §4.3).
//
// WHAT THIS BUYS. Before it, every caller reached a person's records through ONE broad grant shared by
// the Home and every app they had ever connected. "Revoke this app" therefore meant deleting its OIDC
// client registration: a registry edit at one server, not an authority change. Other Homes kept
// working, another copy of the token kept working, and nobody auditing the chain could see that access
// had been withdrawn.
//
// A per-app delegation is revocable ON-CHAIN. The revoke stops that app at every gate that checks, is
// visible to anyone who looks, and touches no other app.
//
// WHY THE DELEGATE IS NOT THE APP. It is the interactions service SA — the party that actually performs
// the vault call. Delegating to the app would mean the app itself calls the vault, which is precisely
// the browser→MCP shape ADR-0044 forbids. What varies per app is WHICH delegation authorizes the read,
// and therefore what a revocation kills; the hop is unchanged.
//
// SCOPED, NOT WHOLE-VAULT. `buildVaultRecordScopeCaveat` refuses `vault:*` outright. An app that reads
// mail gets `vault:inbox.data` and the dm-body family, and nothing else — so a compromised app cannot
// walk into the profile, the relationship graph, or an org's records.

import {
  buildCaveat,
  buildVaultRecordScopeCaveat,
  encodeTimestampTerms,
  hashDelegation,
  ROOT_AUTHORITY,
  type Caveat,
  type Delegation,
} from '@agenticprimitives/delegation';
import type { Address } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from './chain';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import { SESSION_KEY } from '../context/session';
import { readSsoCookie } from './sso-cookie';
import type { SignHash } from '../home/resolution';

/**
 * What an inbox-reading app needs, and deliberately nothing more.
 *
 * `inbox.data` is the projection; the dm-body family is the message bodies it renders. Both are
 * required for a usable inbox and neither implies the other, so listing them together is the minimum
 * rather than a convenience bundle.
 */
export const INBOX_READ_RESOURCES = ['vault:inbox.data', 'vault:message.body:dm:*'] as const;

/**
 * The person's PRIVATE capability record — what the Home's `/skills` page holds (spec 341 §4.3a).
 *
 * A separate set, not an addition to the inbox one, because they are separate decisions: an app that
 * renders your mail has no business reading what you can do, and an app matching you to work has no
 * business reading your mail. Bundling them would make "authorize this app" a single coarse yes, which
 * is the property per-app grants exist to end.
 *
 * NOT the same thing as the PUBLISHED subset: `atl:skills` is an owner-signed profile property the
 * discovery matcher ranks, public by construction and needing no grant to read. This covers the private
 * record the published subset is chosen FROM.
 */
export const CAPABILITY_READ_RESOURCES = ['vault:skills.data'] as const;

/** Default lifetime. Long enough not to be a nuisance, short enough that expiry is a real bound and not
 *  a formality — the same reasoning as the messaging wire. */
export const READ_GRANT_VALIDITY_SECONDS = 30 * 24 * 60 * 60;

function homeBearer(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    if (t) return t;
  } catch { /* fall through */ }
  return readSsoCookie()?.token ?? '';
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  return salt;
}

export interface ReadGrantInput {
  /** The person whose records the app will read. Delegator, and the account that must sign. */
  personSA: Address;
  /** The interactions service SA — the delegate the agent pins. */
  serviceSA: Address;
  /**
   * Resources this app may read — `INBOX_READ_RESOURCES`, `CAPABILITY_READ_RESOURCES`, or any other
   * record family. Defaults to the inbox set; NEVER `vault:*` (the builder refuses it).
   *
   * The grant is DECLARATIVE: it says what it covers, and each op checks what it needs. An earlier
   * version required `vault:inbox.data` in every grant, which made this inbox-only while wearing a
   * general name — a capability-record grant could not be issued at all.
   */
  resources?: readonly string[];
  /** The MCP server the scope binds to. */
  server: string;
  /** The person's custody credential — passkey / wallet / KMS, routed by `signHashFor(via)`. */
  signHash: SignHash;
  validitySeconds?: number;
  now?: () => number;
  salt?: bigint;
}

/**
 * Mint + sign a read grant for one app.
 *
 * Fail-closed on the shapes the agent would reject anyway: no resources, or a resource set missing
 * `vault:inbox.data`, which would store an app that appears authorized and fails at every read.
 */
export async function issueReadGrant(input: ReadGrantInput): Promise<Delegation> {
  const resources = [...new Set(input.resources ?? INBOX_READ_RESOURCES)];
  if (resources.length === 0) throw new Error('a read grant must name at least one resource');
  const nowSec = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const caveats: Caveat[] = [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, nowSec + (input.validitySeconds ?? READ_GRANT_VALIDITY_SECONDS))),
    // READ ONLY. `ops` is a required field and the temptation is to mirror whatever the interactions
    // grant carries; this grant must not. An app authorized to render your mail has no business
    // writing or tombstoning records, and demo-mcp enforces `ops` per call — so a compromised reader
    // cannot become a writer even against a resource it is legitimately scoped to.
    buildVaultRecordScopeCaveat([{ server: input.server, resources, ops: ['read'] }]),
  ];
  const d: Delegation = {
    delegator: input.personSA,
    delegate: input.serviceSA,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: input.salt ?? randomSalt(),
    signature: '0x',
  };
  d.signature = await input.signHash(hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager));
  if (!d.signature || d.signature === '0x') throw new Error('read grant was not signed');
  return d;
}

const toWire = (d: Delegation): unknown => ({ ...d, salt: d.salt.toString() });

async function op<T>(person: Address, name: string, payload: Record<string, unknown>): Promise<T> {
  await ensureCsrfToken();
  const session = homeBearer();
  if (!session) throw new Error('no home session');
  const res = await fetch(`/a2a/interactions/${person.toLowerCase()}/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ session, ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `${name} failed (${res.status})`));
  return body as T;
}

/** Authorize one app to read. `clientId` is the app's OIDC `aud` — the same value the agent verifies on
 *  every call, so the grant and the caller are keyed by the same fact. */
export async function putReadGrant(person: Address, clientId: string, grant: Delegation): Promise<void> {
  await op(person, 'readgrant.put', { clientId, delegation: toWire(grant) });
}

/** The apps this person has authorized, with each grant's ON-CHAIN status — not the stored row, so a
 *  revoke that landed is visible here. */
export async function listReadGrants(person: Address): Promise<Array<{ clientId: string; hash: string; storedAt: string; revoked: boolean }>> {
  const r = await op<{ grants?: Array<{ clientId: string; hash: string; storedAt: string; revoked: boolean }> }>(person, 'readgrant.list', {});
  return r.grants ?? [];
}

/**
 * Drop this Home's copy of an app's grant.
 *
 * NOT a revocation, and the name is deliberately not `revokeReadGrant`. This stops US using it; the
 * authority kill is revoking the delegation on-chain, which stops the app at every gate that checks.
 * A caller who does only this has not revoked anything — the same distinction the messaging wire makes.
 */
export async function dropReadGrant(person: Address, clientId: string): Promise<void> {
  await op(person, 'readgrant.revoke', { clientId });
}
