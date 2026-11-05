// THE `app-grants:<person>` ROW (spec 397 W4; grown by spec 445 §4). A pointer that can be rebuilt: the wires are the
// record, held by the app and checkable on chain, and losing a row costs the person one sheet. It holds no name, no
// email, nothing sealed. A row with no `terms` (every row written before spec 445, or one the person told to forget) is
// "no remembered consent": it still lists its wires, so they can still be revoked, and it never skips a sheet.
import { hashDelegation, type Delegation } from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN_ID, CONTRACTS } from '../../src/lib/chain';
import { termsDigest, wireValidUntil, type ConsentTermsV1 } from '../../src/lib/consent-terms';
import type { IncomingDelegation } from '../_lib/verify-delegation';

export type WireKind = 'site' | 'ask' | 'vault';
export interface SupersededWire { ref: string; kind: WireKind; validUntil: number | null; wire: IncomingDelegation }

export interface AppGrantRow {
  clientId: string;
  template: string;
  delegate: string;
  delegation: IncomingDelegation;
  issuedAt: number;
  /** Spec 397 §11 — the act-as-me set. */
  wires?: unknown[];
  v?: 2;
  terms?: ConsentTermsV1;
  termsDigest?: string;
  askDelegation?: IncomingDelegation;
  selfVaultGrant?: IncomingDelegation;
  /** The redirect origins this Allow has been delivered to. */
  origins?: string[];
  lastUsedAt?: number;
  /** Older wires for this client, still live on chain until their own expiry: kept whole, because revoking takes the wire. */
  superseded?: SupersededWire[];
  /** The person's own switch: show the sheet here every time. */
  askEveryTime?: true;
}

const MAX_SUPERSEDED = 12;

/** The canonical EIP-712 digest of a wire, the same bytes the DelegationManager computes. */
export function wireRef(d: IncomingDelegation): Hex {
  const delegation: Delegation = {
    delegator: d.delegator as Address,
    delegate: d.delegate as Address,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
    salt: BigInt(d.salt),
    signature: d.signature,
  };
  return hashDelegation(delegation, CHAIN_ID, CONTRACTS.delegationManager as Address);
}

const currentWires = (r: AppGrantRow): Array<[WireKind, IncomingDelegation]> => [
  ['site', r.delegation],
  ...(r.askDelegation ? ([['ask', r.askDelegation]] as Array<[WireKind, IncomingDelegation]>) : []),
  ...(r.selfVaultGrant ? ([['vault', r.selfVaultGrant]] as Array<[WireKind, IncomingDelegation]>) : []),
];

/** A wire that cannot be hashed (a stub, a row from before wires were whole) is left out of the list, not fatal to a sign-in. */
function safeRef(d: IncomingDelegation): string | null {
  try { return wireRef(d).toLowerCase(); } catch { return null; }
}

export interface NewAllow {
  clientId: string;
  template: string;
  delegate: string;
  delegation: IncomingDelegation;
  askDelegation?: IncomingDelegation | null;
  selfVaultGrant?: IncomingDelegation | null;
  wires?: unknown[];
  /** The registry's terms for this sign-in, or null for a template whose consent is never remembered (act-as-me). */
  terms: ConsentTermsV1 | null;
  origin: string;
  now: number;
}

/** The row a sheet writes. The stored terms say what these wires actually carry: a registry that declares an ask wire
 *  on a sign-in that did not mint one stores `ask: false`, so the next sign-in asks rather than handing back nothing. */
export function nextAppGrantRow(prev: AppGrantRow | undefined, a: NewAllow): AppGrantRow {
  const row: AppGrantRow = {
    clientId: a.clientId,
    template: a.template,
    delegate: a.delegate,
    delegation: a.delegation,
    issuedAt: a.now,
    ...(a.wires ? { wires: a.wires } : {}),
  };
  if (a.terms) {
    const terms: ConsentTermsV1 = {
      ...a.terms,
      ask: a.terms.template === 'ask-as-me' || (a.terms.ask && !!a.askDelegation),
      selfVault: a.selfVaultGrant ? a.terms.selfVault : null,
    };
    const digest = termsDigest(terms);
    row.v = 2;
    row.terms = terms;
    row.termsDigest = digest;
    if (a.askDelegation) row.askDelegation = a.askDelegation;
    if (a.selfVaultGrant) row.selfVaultGrant = a.selfVaultGrant;
    // The same terms keep the origins they were delivered to. Wider terms start again: that Allow was made here, only.
    row.origins = [...new Set([...(prev?.termsDigest === digest ? (prev.origins ?? []) : []), a.origin])];
    row.lastUsedAt = a.now;
    if (prev?.askEveryTime) row.askEveryTime = true;
  }
  // Whatever this Allow replaced is still live on chain. It moves to `superseded`, where it can be seen and revoked.
  const keep = new Set(currentWires(row).map(([, w]) => safeRef(w)));
  const replaced: SupersededWire[] = [];
  if (prev) {
    for (const [kind, wire] of currentWires(prev)) {
      const ref = safeRef(wire);
      if (ref && !keep.has(ref)) replaced.push({ ref, kind, wire, validUntil: wireValidUntil(wire, CONTRACTS.timestampEnforcer) });
    }
  }
  const stillLive = [...replaced, ...(prev?.superseded ?? [])]
    .filter((s) => (s.validUntil === null || s.validUntil > a.now) && !keep.has(s.ref))
    .slice(0, MAX_SUPERSEDED);
  if (stillLive.length) row.superseded = stillLive;
  return row;
}

export const readRows = async (kv: { get(k: string): Promise<string | null> }, person: string): Promise<AppGrantRow[]> =>
  JSON.parse((await kv.get(`app-grants:${person.toLowerCase()}`)) ?? '[]') as AppGrantRow[];
