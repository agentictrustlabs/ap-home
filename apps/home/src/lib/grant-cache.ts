// The standing site grant this browser already minted for (person, delegate).
//
// spec 253's approved-hash site delegation is a PUBLIC `0x03` leaf whose digest approval is
// already on-chain from the first connect. Re-consenting to the same app used to mint a fresh
// random-salt duplicate and pay a whole userOp (~7s at the Allow click) to approve an
// identical-scope grant. Presenting the standing grant instead is not a bypass: /oidc/grant
// re-verifies revocation + ERC-1271 on every use, so a revoked grant still fails closed —
// the caller then clears this cache and mints fresh (one explicit fallback, ADR-0013).
import type { Address } from '@agenticprimitives/types';
import type { DelegationWire } from './delegation';

const key = (person: Address, delegate: Address) =>
  `agenticprimitives:demo-sso:site-grant:${person.toLowerCase()}:${delegate.toLowerCase()}`;

/** Never reuse into the grant's final month — the app holds it for the session that follows. */
const MIN_REMAINING_MS = 30 * 86_400_000;

interface StandingGrant {
  readonly wire: DelegationWire;
  readonly expiresAt: number;
}

export function saveStandingGrant(person: Address, delegate: Address, wire: DelegationWire, expiresAt: number): void {
  try {
    localStorage.setItem(key(person, delegate), JSON.stringify({ wire, expiresAt } satisfies StandingGrant));
  } catch {
    /* storage blocked — the next connect just mints again */
  }
}

export function loadStandingGrant(person: Address, delegate: Address): DelegationWire | null {
  try {
    const raw = localStorage.getItem(key(person, delegate));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StandingGrant;
    if (!parsed.wire || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt - Date.now() < MIN_REMAINING_MS) {
      localStorage.removeItem(key(person, delegate));
      return null;
    }
    return parsed.wire;
  } catch {
    return null;
  }
}

export function clearStandingGrant(person: Address, delegate: Address): void {
  try {
    localStorage.removeItem(key(person, delegate));
  } catch {
    /* nothing to clear */
  }
}
