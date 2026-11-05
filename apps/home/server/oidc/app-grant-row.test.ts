// Spec 445 §4 — the row a sheet writes: the terms, every wire, and what it replaced.
import { describe, expect, it, vi } from 'vitest';
import { encodeTimestampTerms } from '@agenticprimitives/delegation';

vi.mock('../../src/lib/chain', async (orig) => { const real = await orig<{ CONTRACTS: object }>(); return { ...real, CONTRACTS: { ...real.CONTRACTS, timestampEnforcer: '0x00000000000000000000000000000000000000aa' } }; });
import { nextAppGrantRow, wireRef, type AppGrantRow } from './app-grant-row';
import { termsFor } from '../../src/lib/consent-terms';
import type { RelyingApp } from '../../src/whitelabel/schema';
import type { IncomingDelegation } from '../_lib/verify-delegation';

const PERSON = '0xeef5ed02e052ee221afcbbd2708919473c4e2b28' as const;
const SITE = '0x89d13c596c45e4ee80af5ae06c727fe9a820ffd0' as const;
const ASK = '0xb77a627a4ad23af518f9626186f7be4d2cc4bff1' as const;
const NOW = 1_800_000_000_000;
const wire = (delegate: string, salt: string, until = 2_000_000_000): IncomingDelegation => ({
  delegator: PERSON, delegate: delegate as `0x${string}`, authority: `0x${'00'.repeat(32)}`, salt, signature: '0x03',
  caveats: [{ enforcer: '0x00000000000000000000000000000000000000aa', terms: encodeTimestampTerms(1, until) }],
});
const reader = (over: Partial<RelyingApp> = {}) => ({ client_id: 'reader', redirect_uris: [], allowed_scopes: ['profile'], allowed_delegation_templates: ['site-login'], delegate: SITE, ask_delegate: ASK, ask_with_login: true, ...over }) as RelyingApp;
const allow = (prev: AppGrantRow | undefined, over: Record<string, unknown> = {}) => nextAppGrantRow(prev, {
  clientId: 'reader', template: 'site-login', delegate: SITE, delegation: wire(SITE, '1'), askDelegation: wire(ASK, '2'),
  terms: termsFor(reader(), 'site-login'), origin: 'https://reader.test', now: NOW, ...over,
});

describe('the row', () => {
  it('holds the terms and both wires', () => {
    const r = allow(undefined);
    expect(r).toMatchObject({ v: 2, clientId: 'reader', origins: ['https://reader.test'], lastUsedAt: NOW });
    expect(r.terms?.ask).toBe(true);
    expect(r.termsDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.askDelegation?.delegate).toBe(ASK);
  });
  it('stores what the wires carry: an ask wire the sign-in did not mint is not agreed', () => {
    expect(allow(undefined, { askDelegation: null }).terms?.ask).toBe(false);
  });
  it('holds no terms for a template that is never remembered, as a row always was', () => {
    const r = allow(undefined, { template: 'act-as-me', terms: null, wires: [{ ref: '0x1' }], askDelegation: null });
    expect(r.terms).toBeUndefined();
    expect(r.wires).toEqual([{ ref: '0x1' }]);
  });
  it('remembers nothing with no proof of the person, and still lists the wires so they can be revoked', () => {
    const r = allow(undefined, { terms: null });
    expect(r.terms).toBeUndefined();
    expect(r.origins).toBeUndefined();
    expect(r.askDelegation?.delegate).toBe(ASK);
  });
  it('a row with no proof clears what an earlier Allow remembered', () => {
    expect(allow(allow(undefined), { terms: null }).terms).toBeUndefined();
  });
  it('moves what an Allow replaced to superseded, whole, so it can still be revoked', () => {
    const first = allow(undefined);
    const second = allow(first, { delegation: wire(SITE, '3'), askDelegation: wire(ASK, '4') });
    expect(second.superseded?.map((s) => s.kind).sort()).toEqual(['ask', 'site']);
    expect(second.superseded?.find((s) => s.kind === 'site')?.wire).toEqual(wire(SITE, '1'));
    expect(second.superseded?.find((s) => s.kind === 'site')?.ref).toBe(wireRef(wire(SITE, '1')).toLowerCase());
    expect(second.superseded?.find((s) => s.kind === 'site')?.validUntil).toBe(2_000_000_000_000);
  });
  it('does not list a wire as replaced when the same one came back (a reused standing grant)', () => {
    const second = allow(allow(undefined), { askDelegation: wire(ASK, '9') });
    expect(second.superseded?.map((s) => s.kind)).toEqual(['ask']);
  });
  it('lets a superseded wire go once it has expired', () => {
    const old = allow(undefined, { delegation: wire(SITE, '1', 1_700_000_000) });
    expect(allow(old, { delegation: wire(SITE, '3') }).superseded?.map((s) => s.kind) ?? []).toEqual([]);
  });
  it('keeps the origins under the same terms and starts again under wider ones', () => {
    const first = allow(undefined);
    expect(allow(first, { origin: 'https://b.test' }).origins).toEqual(['https://reader.test', 'https://b.test']);
    const wider = allow(first, { origin: 'https://b.test', terms: termsFor(reader({ read_grant: { resources: ['vault:x'] } }), 'site-login') });
    expect(wider.origins).toEqual(['https://b.test']);
  });
  it('keeps the person\'s own switch across a new Allow', () => {
    expect(allow({ ...allow(undefined), askEveryTime: true }).askEveryTime).toBe(true);
  });
  it('tolerates a row from before wires were whole', () => {
    const v1 = { clientId: 'reader', template: 'site-login', delegate: SITE, delegation: { caveats: [] }, issuedAt: 1 } as unknown as AppGrantRow;
    expect(allow(v1).superseded).toBeUndefined();
  });
});
