// A REAL STORE FOR CATALOG TESTS: the vault's own encrypted adapter (`createDemoVault`) over its own SQL (`db.ts`) on
// node:sqlite, with a fixed test key. Also the vault tools' record semantics (`catalog-store.ts`, exactly the functions
// the router calls after authenticating) as a dispatcher — the interactions DO's tests drive this instead of a mock, so
// a DO test can only pass against what the vault actually does.
import type { DekWrapper } from '@agenticprimitives/vault';
import { createDemoVault, type DemoVault } from '../../src/vault.js';
import { commitCatalog, getStoredCatalogRecords, readVaultRecordData, writeVaultRecord } from '../../src/catalog-store.js';

let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'] | undefined;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* unavailable */ }
export const sqliteAvailable = !!DatabaseSync;

const SCHEMA = `CREATE TABLE vault_objects (
  owner_address TEXT NOT NULL, resource TEXT NOT NULL, classification TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL, wrapped_dek_b64 TEXT NOT NULL, crypto_meta TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (owner_address, resource));`;

const KEY = new Uint8Array(32).fill(7);
const wrapper: DekWrapper = {
  async generateSessionDataKey() { return { plaintextDataKey: KEY.slice(), encryptedDataKey: new Uint8Array([1, 2, 3]), keyId: 'test', keyVersion: '1' }; },
  async decryptSessionDataKey() { return KEY.slice(); },
};

export function sqliteVault() {
  const sqlite = new DatabaseSync!(':memory:');
  sqlite.exec(SCHEMA);
  const db = {
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
  } as unknown as D1Database;
  const vault: DemoVault = createDemoVault(db, wrapper);
  /** Raw SQL, for a test that must do what no API allows (a write that bypasses every guard). */
  const exec = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...(params as never[]));
  return { vault, exec, sqlite };
}

/** The vault tools' bodies, after authentication, for one owner — the responses the router sends. */
export function vaultTools(vault: DemoVault, owner: string) {
  return async (tool: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    try {
      if (tool === 'get_vault_record') return { status: 200, body: { ok: true, data: await readVaultRecordData(vault, owner, `vault:${String(args.recordType)}`) } };
      if (tool === 'get_vault_records') {
        const records: Record<string, unknown> = {};
        for (const rt of (args.recordTypes as string[]) ?? []) records[rt] = await readVaultRecordData(vault, owner, `vault:${rt}`);
        return { status: 200, body: { ok: true, records } };
      }
      if (tool === 'set_vault_record') return { status: 200, body: await writeVaultRecord(vault, owner, String(args.recordType), args.data ?? null) };
      if (tool === 'get_catalog_records') return { status: 200, body: await getStoredCatalogRecords(vault, owner, (args.recordTypes as string[]) ?? []) };
      if (tool === 'catalog_commit') return { status: 200, body: await commitCatalog(vault, owner, args) };
      return { status: 200, body: { ok: true, records: [] } };
    } catch (e) {
      // The router's catch: an unexpected throw (a broken paged index) is a 500 with its detail.
      return { status: 500, body: { error: 'internal error', detail: String(e) } };
    }
  };
}
