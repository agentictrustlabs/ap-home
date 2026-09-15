/**
 * The with-self-vault standing grant: the site grant and the self-vault grant minted together are
 * reused together, keyed on the scope so a widened scope mints fresh. The original single-wire entry
 * is untouched — the first test proves the two shapes never read each other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Address } from '@agenticprimitives/types';

import type { DelegationWire, SelfVaultGrantConfig } from './delegation';
import {
  clearStandingGrant,
  loadStandingGrant,
  loadStandingGrantWithSelfVault,
  saveStandingGrant,
  saveStandingGrantWithSelfVault,
  selfVaultScopeKey,
} from './grant-cache';

const person = '0x1111111111111111111111111111111111111111' as Address;
const delegate = '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0' as Address;
const scope: SelfVaultGrantConfig = { server: 'demo-mcp', resources: ['vault:gather27:listing'], ops: ['read', 'write'] };
const site = { delegator: person, delegate, salt: '0x1' } as unknown as DelegationWire;
const vault = { delegator: person, delegate: person, salt: '0x2' } as unknown as DelegationWire;
const year = Date.now() + 365 * 86_400_000;

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage(); });
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

describe('the with-self-vault standing grant', () => {
  it('round-trips both wires, and the plain entry never sees them', () => {
    saveStandingGrantWithSelfVault(person, delegate, scope, site, vault, year);
    expect(loadStandingGrantWithSelfVault(person, delegate, scope)).toEqual({ wire: site, selfVaultGrant: vault });
    expect(loadStandingGrant(person, delegate)).toBeNull();
  });

  it('is keyed on the scope: a widened scope mints fresh', () => {
    saveStandingGrantWithSelfVault(person, delegate, scope, site, vault, year);
    const wider: SelfVaultGrantConfig = { ...scope, resources: ['vault:gather27:listing', 'vault:gather27:report'] };
    expect(loadStandingGrantWithSelfVault(person, delegate, wider)).toBeNull();
  });

  it('the scope key is canonical, so field order cannot split the cache', () => {
    const shuffled: SelfVaultGrantConfig = { server: 'demo-mcp', ops: ['write', 'read'], resources: ['vault:gather27:listing'] };
    expect(selfVaultScopeKey(shuffled)).toBe(selfVaultScopeKey(scope));
    saveStandingGrantWithSelfVault(person, delegate, scope, site, vault, year);
    expect(loadStandingGrantWithSelfVault(person, delegate, shuffled)).not.toBeNull();
  });

  it('is not reused into its final month', () => {
    saveStandingGrantWithSelfVault(person, delegate, scope, site, vault, Date.now() + 20 * 86_400_000);
    expect(loadStandingGrantWithSelfVault(person, delegate, scope)).toBeNull();
  });

  it('clearStandingGrant clears BOTH shapes — the refused-reuse fallback does not know the scope', () => {
    saveStandingGrant(person, delegate, site, year);
    saveStandingGrantWithSelfVault(person, delegate, scope, site, vault, year);
    clearStandingGrant(person, delegate);
    expect(loadStandingGrant(person, delegate)).toBeNull();
    expect(loadStandingGrantWithSelfVault(person, delegate, scope)).toBeNull();
  });
});
