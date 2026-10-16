/**
 * The backfill decision for `atl:nativeId` / `atl:accounts` on names claimed before 2026-10-15.
 *
 * The rules this pins: write only what is missing; never overwrite a declared home; a home declared on
 * another chain is a satellite (leave it); a different address for THIS chain is a conflict (show it).
 */
import { describe, it, expect } from 'vitest';
import { buildDeclareHomeCalls, caip10Of, planHomeAccount, type HomeAccountPlan } from './declare-home-account';

const SA = '0xFd13000000000000000000000000000000000001' as const;
const OTHER = '0x0000000000000000000000000000000000000bad' as const;
const CHAIN = 34348;
const me = caip10Of(CHAIN, SA);

describe('planHomeAccount', () => {
  it('writes both records for a pre-10-15 name carrying only addr', () => {
    const p = planHomeAccount({ name: 'rich-google2.me', records: {} }, SA, CHAIN);
    expect(p).toEqual({ name: 'rich-google2.me', action: 'write', missing: ['nativeId', 'accounts'], records: { nativeId: me, accounts: [me] } });
  });

  it('lower-cases the address inside the CAIP-10 (ADR-0008 grammar)', () => {
    expect(me).toBe(`eip155:${CHAIN}:${SA.toLowerCase()}`);
  });

  it('is a no-op once both records name this account', () => {
    expect(planHomeAccount({ name: 'a.me', records: { nativeId: me, accounts: [me] } }, SA, CHAIN))
      .toEqual({ name: 'a.me', action: 'none', reason: 'declared' });
  });

  it('fills in only the missing half', () => {
    const p = planHomeAccount({ name: 'a.me', records: { nativeId: me } }, SA, CHAIN);
    expect(p.action).toBe('write');
    if (p.action === 'write') { expect(p.missing).toEqual(['accounts']); expect(p.records).toEqual({ accounts: [me] }); }
  });

  it('keeps other chains’ entries when appending this chain', () => {
    const base = 'eip155:8453:0x00000000000000000000000000000000000000ab';
    const p = planHomeAccount({ name: 'a.me', records: { nativeId: me, accounts: [base] } }, SA, CHAIN);
    if (p.action !== 'write') throw new Error(p.action);
    expect(p.records.accounts).toEqual([base, me]);
  });

  it('leaves a satellite alone — the home is declared on another chain', () => {
    const home = 'eip155:8453:0x00000000000000000000000000000000000000ab';
    expect(planHomeAccount({ name: 'a.me', records: { nativeId: home } }, SA, CHAIN))
      .toEqual({ name: 'a.me', action: 'none', reason: 'satellite' });
  });

  it('refuses to overwrite a home declared to a different account on this chain', () => {
    const p = planHomeAccount({ name: 'a.me', records: { nativeId: caip10Of(CHAIN, OTHER) } }, SA, CHAIN);
    expect(p.action).toBe('conflict');
  });

  it('refuses to replace this chain’s accounts entry when it names someone else', () => {
    const p = planHomeAccount({ name: 'a.me', records: { accounts: [caip10Of(CHAIN, OTHER)] } }, SA, CHAIN);
    expect(p.action).toBe('conflict');
  });
});

describe('buildDeclareHomeCalls', () => {
  it('emits two calls per name to write and none for the rest', () => {
    const plans: HomeAccountPlan[] = [
      planHomeAccount({ name: 'alice.me', records: {} }, SA, CHAIN),
      planHomeAccount({ name: 'bobby.me', records: { nativeId: me, accounts: [me] } }, SA, CHAIN),
    ];
    expect(buildDeclareHomeCalls(plans)).toHaveLength(2);
    expect(buildDeclareHomeCalls([])).toHaveLength(0);
  });
});
