// THE PURE HALF of a per-app read grant (spec 341 §4.3b): the struct and the signing, with no browser in it — so the
// Home's server lanes (a demo persona's sign-in) mint the same grant the browser lanes mint. `read-grants.ts` re-exports
// it and adds the browser-side ops (put / list / forget over the person's session).
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
import type { SignHash } from '../home/resolution';

export const INBOX_READ_RESOURCES = ['vault:inbox.data', 'vault:message.body:dm:*'] as const;
export const CAPABILITY_READ_RESOURCES = ['vault:skills.data'] as const;
export const READ_GRANT_VALIDITY_SECONDS = 30 * 24 * 60 * 60;

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

