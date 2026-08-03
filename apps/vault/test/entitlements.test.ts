// The entitlement gate (spec 277 Phase 3 / spec 291 §3) — untested until now, on the check that runs
// BEFORE the vault decrypts any field.
//
// Two resolvers, two DIFFERENT trust models, and getting that distinction wrong is the whole risk:
//
//   demoEntitlementResolver   — cross-principal access goes through the VERIFIED resolver: every
//                               candidate credential is cryptographically verified (issuer signature,
//                               validity window, status) before it can match. An externally-sourced
//                               credential is not trusted because it exists.
//   ledgerEntitlementResolver — the D1 ledger IS the authority. Rows are written only after the org
//                               authenticated as its own custodian, so the WRITE is the authorization
//                               and the matching engine checks no signature.
//
// Both share one property worth pinning hardest: **owner-reads-own is the only unconditional allow**,
// and everything else is fail-closed. A gate that defaulted to allow on an empty credential set would
// look identical in the happy path and hand out other people's data in the real one.

import { describe, it, expect } from 'vitest';
import {
  demoEntitlementResolver,
  ledgerEntitlementResolver,
  buildOrgEntitlement,
} from '../src/entitlements.js';
import type { EntitlementQuery } from '@agenticprimitives/entitlements';

const OWNER = '0x1111111111111111111111111111111111111111';
const READER = '0x2222222222222222222222222222222222222222';
const AUDIENCE = 'https://mcp.example.test/mcp';
const RESOURCE = 'vault:impact-profile';

const query = (over: Partial<EntitlementQuery> = {}): EntitlementQuery => ({
  actor: READER, principal: OWNER, audience: AUDIENCE, resource: RESOURCE,
  action: 'read', fields: ['email', 'phone'],
  // `at` is the instant the validity window is evaluated against — required, because a gate that
  // defaulted to "now" would silently make expiry untestable and time-dependent.
  at: new Date('2025-01-01T00:00:00.000Z'), ...over,
} as EntitlementQuery);

/** A verifier that would accept anything — so a denial below is never a signature artifact. */
const acceptAll = async () => ({ ok: true }) as never;
/** And one that accepts nothing, for the spec-291 branch. */
const rejectAll = async () => ({ ok: false, reason: 'revoked' }) as never;

// ─── D1 fake ─────────────────────────────────────────────────────────────────

interface Row { credential: string; actor: string }
function fakeDb(rows: Row[] = [], groups: { member: string; group_id: string }[] = []) {
  const queries: string[] = [];
  return {
    queries,
    prepare(sql: string) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { bound = args; return api; },
        async all<T>() {
          if (sql.includes('entitlement_groups')) {
            const member = String(bound[0]).toLowerCase();
            return { results: groups.filter((g) => g.member === member).map((g) => ({ group_id: g.group_id })) as T[] };
          }
          const [principal, ...rest] = bound as string[];
          const now = String(rest[rest.length - 1]);
          const actorKeys = rest.slice(0, -1).map((a) => String(a));
          void principal; void now;
          return { results: rows.filter((r) => actorKeys.includes(r.actor)) as unknown as T[] };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const credential = (over: Record<string, unknown> = {}) =>
  buildOrgEntitlement({
    issuer: OWNER, subject: READER, audience: AUDIENCE, resource: RESOURCE,
    actions: ['read'], validFromIso: '2020-01-01T00:00:00.000Z',
    id: `urn:ap:entitlement:${crypto.randomUUID()}`, ...over,
  } as Parameters<typeof buildOrgEntitlement>[0]);

// ─── owner-reads-own ─────────────────────────────────────────────────────────

describe('owner-reads-own is the only unconditional allow', () => {
  it.each([['demo', () => demoEntitlementResolver(acceptAll)], ['ledger', () => ledgerEntitlementResolver({ DB: fakeDb() })]])(
    '%s resolver allows the owner reading its own namespace', async (_n, make) => {
      const d = await make().resolve(query({ actor: OWNER }));
      expect(d.decision).toBe('allow');
      expect(d.matchedCredentials).toEqual(['owner-self']);
    },
  );

  it('scopes the allow to exactly the fields requested — never wider', async () => {
    const d = await demoEntitlementResolver(acceptAll).resolve(query({ actor: OWNER, fields: ['email'] }));
    expect(d.allowedFields).toEqual(['email']);
  });

  // An address is not a string: a checksummed actor is the same owner as a lowercase one, and treating
  // them as different would deny the owner their own data.
  it('matches owner to principal case-insensitively', async () => {
    const d = await demoEntitlementResolver(acceptAll).resolve(
      query({ actor: OWNER.toUpperCase().replace('0X', '0x') }),
    );
    expect(d.decision).toBe('allow');
  });

  // The converse, and the one that matters: "owner-self" must never fire for a DIFFERENT actor.
  it('does NOT fire owner-self for a different actor', async () => {
    const d = await demoEntitlementResolver(acceptAll).resolve(query());
    expect(d.matchedCredentials).not.toContain('owner-self');
    expect(d.decision).toBe('deny');
  });
});

// ─── cross-principal, demo resolver ──────────────────────────────────────────

describe('cross-principal access is fail-closed (demo resolver)', () => {
  // The seeded credential set is EMPTY, so every cross-principal read is denied. That is the correct
  // default, and asserting it means seeding one later is a deliberate act.
  it('DENIES a cross-principal read with no seeded grant', async () => {
    expect((await demoEntitlementResolver(acceptAll).resolve(query())).decision).toBe('deny');
  });

  it('DENIES even when the verifier would accept anything', async () => {
    // Nothing to verify: the denial comes from having no candidate, not from verification.
    expect((await demoEntitlementResolver(acceptAll).resolve(query())).decision).toBe('deny');
    expect((await demoEntitlementResolver(rejectAll).resolve(query())).decision).toBe('deny');
  });

  it('DENIES when there is no principal to compare against', async () => {
    const d = await demoEntitlementResolver(acceptAll).resolve(query({ principal: undefined }));
    expect(d.decision).toBe('deny');
  });
});

// ─── cross-principal, ledger resolver ────────────────────────────────────────

describe('the ledger IS the authority (org → member grants)', () => {
  it('ALLOWS a reader with a direct granted row', async () => {
    const db = fakeDb([{ credential: JSON.stringify(credential()), actor: READER.toLowerCase() }]);
    const d = await ledgerEntitlementResolver({ DB: db }).resolve(query());
    expect(d.decision).toBe('allow');
  });

  it('DENIES a reader with no row — an empty grant set is a denial, not a default', async () => {
    const d = await ledgerEntitlementResolver({ DB: fakeDb([]) }).resolve(query());
    expect(d.decision).toBe('deny');
  });

  it('DENIES when the query names no principal, without touching the database', async () => {
    const db = fakeDb([]);
    const d = await ledgerEntitlementResolver({ DB: db }).resolve(query({ principal: undefined }));
    expect(d.decision).toBe('deny');
    expect((db as unknown as { queries: string[] }).queries).toHaveLength(0);
  });

  // The SQL is where the real gating lives: status, expiry and principal scoping are all applied in
  // the query rather than after it, so an expired or revoked row never reaches the matcher.
  it("filters on granted status and expiry IN THE QUERY, not after", async () => {
    const db = fakeDb([{ credential: JSON.stringify(credential()), actor: READER.toLowerCase() }]);
    await ledgerEntitlementResolver({ DB: db }).resolve(query());
    const sql = (db as unknown as { queries: string[] }).queries.join(' ');
    expect(sql).toContain("status = 'granted'");
    expect(sql).toContain('valid_until IS NULL OR valid_until >');
    expect(sql).toContain('principal = ?');
  });

  // D2 — group-conferred grants. The credential is stored against `group:<id>`; membership in that
  // group IS the authorization, so the subject is rewritten to the concrete reader before matching.
  it('ALLOWS via a GROUP-conferred grant, rewriting the subject to the reader', async () => {
    const groupCred = credential({ subject: 'group:staff' });
    const db = fakeDb(
      [{ credential: JSON.stringify(groupCred), actor: 'group:staff' }],
      [{ member: READER.toLowerCase(), group_id: 'staff' }],
    );
    const d = await ledgerEntitlementResolver({ DB: db }).resolve(query());
    expect(d.decision).toBe('allow');
  });

  it('DENIES a group grant when the reader is not in the group', async () => {
    const db = fakeDb(
      [{ credential: JSON.stringify(credential({ subject: 'group:staff' })), actor: 'group:staff' }],
      [], // no membership
    );
    expect((await ledgerEntitlementResolver({ DB: db }).resolve(query())).decision).toBe('deny');
  });

  // A corrupt row must not take down the gate NOR silently widen it: it is skipped, and the decision
  // rests on whatever valid rows remain.
  it('skips a corrupt row without failing the whole resolve', async () => {
    const db = fakeDb([
      { credential: 'not json', actor: READER.toLowerCase() },
      { credential: JSON.stringify(credential()), actor: READER.toLowerCase() },
    ]);
    expect((await ledgerEntitlementResolver({ DB: db }).resolve(query())).decision).toBe('allow');
  });

  it('DENIES when EVERY row is corrupt — a skipped row is not a granted one', async () => {
    const db = fakeDb([{ credential: '{{{', actor: READER.toLowerCase() }]);
    expect((await ledgerEntitlementResolver({ DB: db }).resolve(query())).decision).toBe('deny');
  });
});

// ─── the credential builder ──────────────────────────────────────────────────

describe('buildOrgEntitlement', () => {
  it('binds issuer, subject, audience and resource', () => {
    const c = credential();
    expect(c.issuer).toBe(OWNER);
    expect(c.credentialSubject.id).toBe(READER);
    expect(c.credentialSubject.principal).toBe(OWNER);
    expect(c.credentialSubject.audience).toBe(AUDIENCE);
    expect(c.credentialSubject.resource).toBe(RESOURCE);
  });

  // OMITTED means "all fields" — so emitting an empty array would silently narrow to nothing, and
  // emitting the key at all when it was not asked for would change the meaning.
  it('omits optional members rather than emitting empty ones', () => {
    const c = credential();
    expect('fields' in c.credentialSubject).toBe(false);
    expect('purpose' in c.credentialSubject).toBe(false);
    expect('classificationCeiling' in c.credentialSubject).toBe(false);
    expect('validUntil' in c).toBe(false);
  });

  it('includes optional members when supplied', () => {
    const c = credential({ fields: ['email'], purpose: 'support', classificationCeiling: 'confidential', validUntilIso: '2030-01-01T00:00:00.000Z' });
    expect(c.credentialSubject.fields).toEqual(['email']);
    expect(c.credentialSubject.purpose).toBe('support');
    expect(c.validUntil).toBe('2030-01-01T00:00:00.000Z');
  });

  it('is a VerifiableCredential of the entitlement type', () => {
    expect(credential().type).toEqual(['VerifiableCredential', 'AgenticEntitlementCredentialV1']);
  });
});
