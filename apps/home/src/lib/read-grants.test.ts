// spec 341 §4.3 — per-app read grants.
//
// The assertions worth having are the BOUNDS, not that a delegation gets built. What this exists to buy
// is revocation granularity, and the ways to lose it silently are: a grant broad enough that revoking
// it breaks everything, a grant that can also WRITE, and a grant missing the one resource that makes it
// usable — which stores an app that looks authorized and fails at every read.

import { describe, it, expect, vi } from 'vitest';
import type { Address, Hex } from '@agenticprimitives/types';
import { decodeVaultRecordScopeTerms, decodeTimestampTerms, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';

vi.mock('../csrf', () => ({ ensureCsrfToken: async () => undefined, csrfHeaders: () => ({}) }));
vi.mock('./sso-cookie', () => ({ readSsoCookie: () => ({ token: 'tok' }) }));
vi.mock('../context/session', () => ({ SESSION_KEY: 'agenticprimitives:home:session' }));

const { issueReadGrant, INBOX_READ_RESOURCES, READ_GRANT_VALIDITY_SECONDS } = await import('./read-grants');

const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const SERVICE = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const NOW = 1_780_000_000_000;

const mint = (over: Partial<Parameters<typeof issueReadGrant>[0]> = {}) =>
  issueReadGrant({
    personSA: ALICE,
    serviceSA: SERVICE,
    server: 'demo-mcp',
    signHash: async () => `0x${'11'.repeat(65)}` as Hex,
    now: () => NOW,
    salt: 1n,
    ...over,
  });

const scopeOf = async (over = {}) => {
  const d = await mint(over);
  const cav = d.caveats.find((c) => c.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())!;
  return decodeVaultRecordScopeTerms(cav.terms);
};

describe('the grant is narrow by construction', () => {
  it('is READ-ONLY', async () => {
    // The single most valuable bound here. An app authorized to render your mail has no business
    // writing or tombstoning records, and `ops` is a required field — so the failure mode is copying
    // whatever the interactions grant carries and quietly handing out write.
    for (const g of await scopeOf()) expect(g.ops).toEqual(['read']);
  });

  it('names only the inbox resources', async () => {
    const resources = (await scopeOf()).flatMap((g) => g.resources);
    expect(resources).toEqual([...INBOX_READ_RESOURCES]);
    // Not the profile, not the relationship graph, not org records. A compromised reader cannot walk
    // sideways into them.
    expect(resources).not.toContain('vault:impact-profile');
    expect(resources).not.toContain('vault:relationships.data');
  });

  it('cannot be minted whole-vault', async () => {
    // `buildVaultRecordScopeCaveat` refuses `vault:*`. Asserted here because "just widen the scope" is
    // the obvious shortcut when an app reports a missing record, and it would undo the entire point.
    await expect(mint({ resources: ['vault:*'] })).rejects.toThrow();
    await expect(mint({ resources: ['vault:inbox.data', 'vault:*'] })).rejects.toThrow();
  });

  it('expires', async () => {
    const d = await mint();
    const ts = d.caveats.find((c) => c.enforcer.toLowerCase() !== VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())!;
    expect(decodeTimestampTerms(ts.terms).validUntil).toBe(BigInt(Math.floor(NOW / 1000) + READ_GRANT_VALIDITY_SECONDS));
  });
});

describe('who it is from and to', () => {
  it('is issued BY the person and TO the interactions service', async () => {
    const d = await mint();
    expect(d.delegator).toBe(ALICE);
    // NOT the app. Delegating to the app would mean the app calls the vault itself — the browser→MCP
    // shape ADR-0044 forbids. What varies per app is which delegation authorizes the read.
    expect(d.delegate).toBe(SERVICE);
  });

  it('is signed by the person’s credential', async () => {
    let signed: Hex | undefined;
    await mint({ signHash: async (h) => { signed = h; return `0x${'22'.repeat(65)}` as Hex; } });
    expect(signed).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses to return an unsigned grant', async () => {
    await expect(mint({ signHash: async () => '0x' as Hex })).rejects.toThrow(/was not signed/);
  });
});

describe('unusable shapes are refused at the mint', () => {
  it('refuses a grant with no resources', async () => {
    await expect(mint({ resources: [] })).rejects.toThrow(/at least one resource/);
  });

  it('refuses one missing vault:inbox.data', async () => {
    // It would store, look authorized in a list, and fail at every read — the worst of the three
    // outcomes, because nothing surfaces until a person wonders why their mail is empty.
    await expect(mint({ resources: ['vault:message.body:dm:*'] })).rejects.toThrow(/vault:inbox.data/);
  });
});
