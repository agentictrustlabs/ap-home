// Regression test for putVaultObjectRow / getVaultObjectRow (2026-07-11 silent-write bug).
//
// The bug: since spec 322 W3a the upsert carried a `... ON CONFLICT DO UPDATE SET ... WHERE ? IS
// NULL OR rev = ?` conditional on EVERY write, even though the CAS is unwired (expectedRev never
// passed). If that predicate failed to match, the DO UPDATE wrote NOTHING — and the `changes === 0`
// conflict check only fired when expectedRev was DEFINED — so a no-op write returned success. Vault
// saves (profile, channel board) "succeeded" but the read-back saw the old value.
//
// These run the ACTUAL SQL against a real SQLite engine (node:sqlite behind a tiny D1 shim) and
// assert the read-back equals what was written — the exact invariant that broke, plus the CAS branch.
//
// HONEST LIMITATION: standard SQLite evaluates the old `WHERE ? IS NULL OR rev = ?` (bound null,null)
// CORRECTLY (the overwrite sticks), so node:sqlite does NOT reproduce the original trigger — it was a
// D1-engine-specific quirk with bound-null parameters in an ON CONFLICT DO UPDATE ... WHERE. What
// actually prevents recurrence is the FIX (the undefined-expectedRev path is now an UNCONDITIONAL
// upsert with no such predicate). These tests lock in the write-must-stick invariant and would catch
// any future logic regression that also fails in standard SQLite; authentic D1-quirk coverage would
// need vitest-pool-workers against a real D1 (a heavier follow-up).
import { describe, it, expect, beforeEach } from 'vitest';
import { putVaultObjectRow, getVaultObjectRow, VaultRevConflictError } from '../src/db';

// node:sqlite is stable in Node 24 / experimental in 22.5+ / absent in ≤ 22.4. Guard the import so
// the suite SKIPS (not hard-fails) on older Node instead of crashing the file at load.
let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'] | undefined;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* unavailable → skip below */ }

// Minimal D1Database shim over node:sqlite — implements only prepare().bind().run()/first() as db.ts
// uses them. run() returns { meta: { changes } }; first() returns the row or null.
function makeD1(sqlite: InstanceType<NonNullable<typeof DatabaseSync>>): unknown {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { params = args; return stmt; },
        async run() { const r = sqlite.prepare(sql).run(...(params as never[])); return { meta: { changes: Number(r.changes) } }; },
        async first<T>() { return (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...(params as never[])) as T[] }; },
      };
      return stmt;
    },
  };
}

const SCHEMA = `CREATE TABLE vault_objects (
  owner_address TEXT NOT NULL, resource TEXT NOT NULL, classification TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL, wrapped_dek_b64 TEXT NOT NULL, crypto_meta TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_address, resource));`;

const OWNER = '0xAbC0000000000000000000000000000000000001';
const RESOURCE = 'vault:impact-profile';
const row = (ct: string) => ({ owner_address: OWNER, resource: RESOURCE, classification: 'internal', ciphertext_b64: ct, wrapped_dek_b64: 'dek', crypto_meta: '{}' });

describe.skipIf(!DatabaseSync)('putVaultObjectRow — writes must stick (read-back equals write)', () => {
  let db: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeEach(() => {
    const sqlite = new DatabaseSync!(':memory:');
    sqlite.exec(SCHEMA);
    db = makeD1(sqlite);
  });

  it('first write persists and reads back', async () => {
    await putVaultObjectRow(db, row('v1'));
    const back = await getVaultObjectRow(db, OWNER, RESOURCE);
    expect(back?.ciphertext_b64).toBe('v1');
    expect(back?.rev).toBe(0);
  });

  it('OVERWRITE sticks — the regression: a second write to the same key must replace the value', async () => {
    await putVaultObjectRow(db, row('v1'));
    await putVaultObjectRow(db, row('v2')); // the write that used to silently no-op
    const back = await getVaultObjectRow(db, OWNER, RESOURCE);
    expect(back?.ciphertext_b64).toBe('v2'); // NOT 'v1' — the vault retained the save
    expect(back?.rev).toBe(1); // rev incremented on the overwrite
  });

  it('owner is lower-cased on write so a mixed-case owner reads back', async () => {
    await putVaultObjectRow(db, { ...row('v1'), owner_address: OWNER.toUpperCase() });
    const back = await getVaultObjectRow(db, OWNER.toLowerCase(), RESOURCE);
    expect(back?.ciphertext_b64).toBe('v1');
  });

  it('CAS: matching expectedRev writes and bumps rev', async () => {
    await putVaultObjectRow(db, row('v1')); // rev 0
    await putVaultObjectRow(db, row('v2'), 0); // expectedRev 0 matches
    const back = await getVaultObjectRow(db, OWNER, RESOURCE);
    expect(back?.ciphertext_b64).toBe('v2');
    expect(back?.rev).toBe(1);
  });

  it('CAS: stale expectedRev throws VaultRevConflictError and leaves the row unchanged', async () => {
    await putVaultObjectRow(db, row('v1')); // rev 0
    await putVaultObjectRow(db, row('v2')); // rev 1 (unconditional)
    await expect(putVaultObjectRow(db, row('v3'), 0)).rejects.toBeInstanceOf(VaultRevConflictError);
    const back = await getVaultObjectRow(db, OWNER, RESOURCE);
    expect(back?.ciphertext_b64).toBe('v2'); // the conflicting write did NOT clobber
    expect(back?.rev).toBe(1);
  });
});
