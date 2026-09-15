// The standing site grant this browser already minted for (person, delegate).
//
// spec 253's approved-hash site delegation is a PUBLIC `0x03` leaf whose digest approval is
// already on-chain from the first connect. Re-consenting to the same app used to mint a fresh
// random-salt duplicate and pay a whole userOp (~7s at the Allow click) to approve an
// identical-scope grant. Presenting the standing grant instead is not a bypass: /oidc/grant
// re-verifies revocation + ERC-1271 on every use, so a revoked grant still fails closed —
// the caller then clears this cache and mints fresh (one explicit fallback, ADR-0013).
import type { Address } from '@agenticprimitives/types';
import type { DelegationWire, SelfVaultGrantConfig } from './delegation';

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

/** The with-self-vault variant is keyed on the SCOPE as well, canonicalised so field order cannot
 *  split the cache: a client whose self-vault scope widens mints fresh rather than reusing a grant
 *  that no longer covers what the app asks for. */
export function selfVaultScopeKey(scope: SelfVaultGrantConfig): string {
  return [scope.server, [...scope.resources].sort().join(','), [...scope.ops].sort().join(',')].join('|');
}
const keyWithSelfVault = (person: Address, delegate: Address, scope: SelfVaultGrantConfig) =>
  `${key(person, delegate)}:self-vault:${selfVaultScopeKey(scope)}`;

/** The with-self-vault entry: the site grant AND the self-vault grant minted together, reused
 *  together. Only a client opted in at the registry ever writes or reads one. */
interface StandingGrantWithSelfVault {
  readonly wire: DelegationWire;
  readonly selfVaultGrant: DelegationWire;
  readonly expiresAt: number;
}

export function saveStandingGrantWithSelfVault(person: Address, delegate: Address, scope: SelfVaultGrantConfig, wire: DelegationWire, selfVaultGrant: DelegationWire, expiresAt: number): void {
  try {
    localStorage.setItem(keyWithSelfVault(person, delegate, scope), JSON.stringify({ wire, selfVaultGrant, expiresAt } satisfies StandingGrantWithSelfVault));
  } catch {
    /* storage blocked — the next connect just mints again */
  }
}

export function loadStandingGrantWithSelfVault(person: Address, delegate: Address, scope: SelfVaultGrantConfig): { wire: DelegationWire; selfVaultGrant: DelegationWire } | null {
  try {
    const k = keyWithSelfVault(person, delegate, scope);
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StandingGrantWithSelfVault;
    if (!parsed.wire || !parsed.selfVaultGrant || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt - Date.now() < MIN_REMAINING_MS) {
      localStorage.removeItem(k);
      return null;
    }
    return { wire: parsed.wire, selfVaultGrant: parsed.selfVaultGrant };
  } catch {
    return null;
  }
}

/** Clears BOTH shapes for (person, delegate). The with-self-vault entries are prefix-scanned because
 *  their key carries the scope; the caller clearing after a refusal does not know which scope it was. */
export function clearStandingGrant(person: Address, delegate: Address): void {
  try {
    const base = key(person, delegate);
    localStorage.removeItem(base);
    const prefix = `${base}:self-vault:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* nothing to clear */
  }
}
