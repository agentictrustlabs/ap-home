// D1-backed profile + JTI access.
//
// Replaces the better-sqlite3 db from the Node version. Same SQL shape;
// same INSERT … ON CONFLICT … RETURNING atomic pattern for JTI.

import type { JtiStore } from '@agenticprimitives/delegation';
import type { AuditEvent, AuditSink } from '@agenticprimitives/audit';

export interface Profile {
  owner_address: string;
  full_name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  updated_at: string;
}

/** Pure seed builder (no DB write) — the encrypted vault adapter materializes +
 *  seals the demo profile into `vault_objects` on first read (the plaintext
 *  `profiles` table was dropped in migration 0007). */
export function buildSeedProfile(owner: string): Profile {
  return {
    owner_address: owner.toLowerCase(),
    full_name: `Demo User (${owner.slice(0, 6)}…${owner.slice(-4)})`,
    email: `${owner.slice(2, 10)}@demo.agenticprimitives.local`,
    phone: '+1-555-0100',
    notes: 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
}

// JtiStore backed by D1. INSERT…ON CONFLICT…RETURNING gives us atomic
// increment-and-read per spec 205 §5.
export function createD1JtiStore(db: D1Database, table: string = 'token_usage'): JtiStore {
  return {
    // NEW-DELEGATION-JTI-AMP-1 — read-only replay peek (no increment). verify calls this before the on-chain
    // reads so a replayed token is rejected without RPC amplification. Returns true iff already at/over limit.
    async peekConsumed(jti: string, limit: number) {
      const row = await db.prepare(`SELECT usage, inflight FROM ${table} WHERE jti = ?`).bind(jti).first<{ usage: number; inflight: number }>();
      if (!row) return false;
      return (row.usage + (row.inflight ?? 0)) >= limit;
    },
    async trackUsage(jti: string, limit: number) {
      const row = await db
        .prepare(
          `INSERT INTO ${table} (jti, usage) VALUES (?, 1)
           ON CONFLICT(jti) DO UPDATE SET usage = usage + 1
           RETURNING usage`,
        )
        .bind(jti)
        .first<{ usage: number }>();
      const current = row?.usage ?? 1;
      return { usage: current, allowed: current <= limit };
    },
    // spec 290 §3 / MRT-1 — two-phase reserve. withDelegation defaults to
    // usageMode:'reserve' when a Stage-2 soft limiter is present (a throttled 429
    // must RELEASE the reserved use, never burn it). Without this the D1 store had
    // only trackUsage and verifyDelegationToken failed closed for every gated call
    // (token.ts:972). D1 is SQLite dialect → identical two-phase SQL to
    // createSqliteJtiStore (mcp-runtime/src/jti-stores.ts:173). Requires the
    // `inflight` column (migration 0009). Atomic: reserve iff usage+inflight<limit;
    // commit moves a slot in-flight→committed; release frees it (usage NEVER drops).
    async reserveUsage(jti: string, limit: number) {
      const row = await db
        .prepare(
          `INSERT INTO ${table} (jti, usage, inflight) VALUES (?, 0, 1)
           ON CONFLICT(jti) DO UPDATE SET inflight = inflight + 1 WHERE usage + inflight < ?
           RETURNING usage`,
        )
        .bind(jti, limit)
        .first<{ usage: number }>();
      if (!row) return { allowed: false };
      let settled = false;
      return {
        allowed: true,
        reservation: {
          async commit() {
            if (settled) return;
            settled = true;
            await db.prepare(`UPDATE ${table} SET usage = usage + 1, inflight = inflight - 1 WHERE jti = ?`).bind(jti).run();
          },
          async release() {
            if (settled) return;
            settled = true;
            await db.prepare(`UPDATE ${table} SET inflight = inflight - 1 WHERE jti = ?`).bind(jti).run();
          },
        },
      };
    },
  };
}

/**
 * Durable D1 audit sink (audit C3 pass 3b). Appends each event to the
 * `audit_events` table created by migration 0002. Append-only — the
 * application code has no UPDATE/DELETE path.
 *
 * Fail-soft: any DB failure is swallowed + logged to console. The
 * caller's request flow is never broken by an audit-emission error.
 * Production wiring typically composes this with the console sink via
 * `composeSinks(consoleSink, d1Sink)` so a D1 outage doesn't blackhole
 * forensics — the console line still lands in `wrangler tail`.
 */
export function createD1AuditSink(
  db: D1Database,
  table: string = 'audit_events',
): AuditSink {
  return {
    async write(event: AuditEvent) {
      try {
        await db
          .prepare(
            `INSERT INTO ${table} (
              id, timestamp, action, outcome, correlation_id,
              actor_type, actor_id, subject_type, subject_id,
              reason, audience, chain_id, digest, context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.timestamp,
            event.action,
            event.outcome,
            event.correlationId ?? null,
            event.actor?.type ?? null,
            event.actor?.id ?? null,
            event.subject?.type ?? null,
            event.subject?.id ?? null,
            event.reason ?? null,
            event.audience ?? null,
            event.chainId ?? null,
            event.digest ?? null,
            event.context ? JSON.stringify(event.context) : null,
          )
          .run();
      } catch (e) {
        // Fail-soft: log but don't propagate. composeSinks already
        // catches this; belt-and-braces.
        console.error('[d1-audit-sink] write failed:', e);
      }
    },
  };
}

// ─── Person PII + Org sensitive — record shapes ──────────────────────
//
// These are the payload TYPES the vault seals/returns (the plaintext
// person_pii/org_sensitive tables + their accessors were dropped in
// migration 0006 — all reads now go through the encrypted `vault_objects`
// store via demoVault). Only the type defs + the seed builders below remain.

export interface PersonPii {
  subject_address: string;
  full_name: string;
  email: string;
  phone: string | null;
  dob: string | null;
  ssn_last4: string | null;
  postal_address: string | null;
  notes: string | null;
  updated_at: string;
}

export interface OrgSensitive {
  org_address: string;
  legal_name: string;
  ein: string | null;
  incorporated_in: string | null;
  ytd_revenue_usd: number | null;
  active_contracts: number | null;
  pending_litigation: number | null;
  primary_banking: string | null;
  notes: string | null;
  updated_at: string;
}

// ─── spec 277 Phase 2 — envelope-encrypted vault storage ───────────────
//
// Pure seed builders (no DB write) so the encrypted vault adapter can
// materialize the demo PII/org defaults and seal them into `vault_objects`
// directly on first read.

export function buildSeedPii(subject: string): PersonPii {
  const addr = subject.toLowerCase();
  return {
    subject_address: addr,
    full_name: `Demo Person (${subject.slice(0, 6)}…${subject.slice(-4)})`,
    email: `${subject.slice(2, 10).toLowerCase()}@demo.agenticprimitives.local`,
    phone: '+1-555-0142',
    dob: '1985-06-15',
    ssn_last4: subject.slice(-4),
    postal_address: '1 Demo Way, Springfield, IL 62701',
    notes: 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
}

export function buildSeedOrgSensitive(orgAddress: string): OrgSensitive {
  return {
    org_address: orgAddress.toLowerCase(),
    legal_name: 'Acme Construction LLC',
    ein: '87-4421099',
    incorporated_in: 'Delaware',
    ytd_revenue_usd: 12_840_000,
    active_contracts: 14,
    pending_litigation: 0,
    primary_banking: 'Chase Business · acct ****8821',
    notes: 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
}

export interface VaultObjectRow {
  owner_address: string;
  resource: string;
  classification: string;
  ciphertext_b64: string;
  wrapped_dek_b64: string;
  crypto_meta: string; // JSON: { alg, dekKid, keyVersion, aadHash }
  /** spec 322 W3 — optimistic concurrency: increments on every upsert; callers MAY CAS on it. */
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Read one live encrypted vault object; `null` if absent or tombstoned. */
export async function getVaultObjectRow(
  db: D1Database,
  owner: string,
  resource: string,
): Promise<VaultObjectRow | null> {
  return (
    (await db
      .prepare(
        'SELECT * FROM vault_objects WHERE owner_address = ? AND resource = ? AND deleted_at IS NULL',
      )
      .bind(owner.toLowerCase(), resource)
      .first<VaultObjectRow>()) ?? null
  );
}

/** Upsert an encrypted vault object (clears any tombstone). `rev` increments on every update
 *  (spec 322 W3). When `expectedRev` is passed, the update applies ONLY if the stored rev matches —
 *  an atomic compare-and-swap; a mismatch throws VaultRevConflictError instead of clobbering
 *  (defense-in-depth: the per-principal DO is the ordering authority; out-of-band writers are
 *  REJECTED, never silently merged). */
export class VaultRevConflictError extends Error {
  constructor(resource: string) { super(`vault_rev_conflict: ${resource}`); }
}
export async function putVaultObjectRow(
  db: D1Database,
  row: Pick<VaultObjectRow, 'owner_address' | 'resource' | 'classification' | 'ciphertext_b64' | 'wrapped_dek_b64' | 'crypto_meta'>,
  expectedRev?: number,
): Promise<void> {
  const UPSERT = `INSERT INTO vault_objects (owner_address, resource, classification, ciphertext_b64, wrapped_dek_b64, crypto_meta, rev)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(owner_address, resource) DO UPDATE SET
         classification = excluded.classification,
         ciphertext_b64 = excluded.ciphertext_b64,
         wrapped_dek_b64 = excluded.wrapped_dek_b64,
         crypto_meta = excluded.crypto_meta,
         updated_at = CURRENT_TIMESTAMP,
         deleted_at = NULL,
         rev = vault_objects.rev + 1`;
  const owner = row.owner_address.toLowerCase();
  // No expected rev → an UNCONDITIONAL upsert (the common path — CAS is opt-in and currently unwired).
  // A `WHERE ? IS NULL OR rev = ?` conditional on every write is pure downside: if that predicate ever
  // fails to match (a null-binding / evaluation quirk), the DO UPDATE writes NOTHING yet `changes`
  // is not checked when expectedRev is undefined — a silent write-that-doesn't-stick (2026-07-11).
  if (expectedRev === undefined) {
    await db.prepare(UPSERT).bind(owner, row.resource, row.classification, row.ciphertext_b64, row.wrapped_dek_b64, row.crypto_meta).run();
    return;
  }
  // Explicit CAS: the conditional DO UPDATE writes only when the stored rev matches; changes=0 ⇒ conflict.
  const res = await db
    .prepare(`${UPSERT}\n       WHERE vault_objects.rev = ?`)
    .bind(owner, row.resource, row.classification, row.ciphertext_b64, row.wrapped_dek_b64, row.crypto_meta, expectedRev)
    .run();
  if ((res.meta?.changes ?? 1) === 0) {
    throw new VaultRevConflictError(row.resource);
  }
}

/** Soft-delete (tombstone) an encrypted vault object. */
export async function tombstoneVaultObjectRow(db: D1Database, owner: string, resource: string): Promise<void> {
  await db
    .prepare(
      'UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE owner_address = ? AND resource = ?',
    )
    .bind(owner.toLowerCase(), resource)
    .run();
}

/** Enumerate the owner's live encrypted vault objects (no payloads). */
export async function listVaultObjectRows(
  db: D1Database,
  owner: string,
): Promise<Array<{ resource: string; classification: string; updated_at: string }>> {
  const res = await db
    .prepare(
      'SELECT resource, classification, updated_at FROM vault_objects WHERE owner_address = ? AND deleted_at IS NULL ORDER BY resource',
    )
    .bind(owner.toLowerCase())
    .all<{ resource: string; classification: string; updated_at: string }>();
  return res.results ?? [];
}

/**
 * The rows a SELECTOR matches — spec 356 §2.3, the query that runs IN the store.
 *
 * `resource IN (…)` for singletons, `resource LIKE 'prefix%'` for keyed families, `LIMIT` always. The
 * alternative — list every resource and fetch each — moves a person's whole vault to the caller to
 * answer a question about three records of it, and turns one authorization into hundreds.
 *
 * An EMPTY selector matches nothing and does not touch the database. That is deliberate: a query that
 * quietly meant "everything" when its selector failed to compile is precisely the bug this shape exists
 * to make impossible. `LIKE` needs its wildcards escaped — a resource prefix is caller-influenced, and
 * an unescaped `%` in one would silently widen the match.
 */
export async function queryVaultObjectRows(
  db: D1Database,
  owner: string,
  select: { exact?: string[]; prefixes?: string[] },
  limit = 200,
): Promise<VaultObjectRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [owner.toLowerCase()];
  const exact = (select.exact ?? []).filter((e) => e.length > 0);
  if (exact.length) {
    clauses.push(`resource IN (${exact.map(() => '?').join(', ')})`);
    binds.push(...exact);
  }
  for (const prefix of (select.prefixes ?? []).filter((p) => p.length > 0)) {
    clauses.push("resource LIKE ? ESCAPE '\\'");
    binds.push(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (!clauses.length) return [];
  binds.push(Math.max(1, Math.min(limit, 500)));
  const res = await db
    .prepare(
      `SELECT owner_address, resource, classification, ciphertext_b64, wrapped_dek_b64, crypto_meta, updated_at
         FROM vault_objects
        WHERE owner_address = ? AND deleted_at IS NULL AND (${clauses.join(' OR ')})
        ORDER BY resource
        LIMIT ?`,
    )
    .bind(...binds)
    .all<VaultObjectRow>();
  return res.results ?? [];
}

// ─── spec 278 P4 — per-person vault key bindings ──────────────────────────

export interface VaultKeyBindingRow {
  owner_address: string;
  server_id: string;
  vault_id: string;
  kms_key_ref: string;
  allowed_resources: string; // JSON string[]
  classification_ceiling: string;
  ops: string; // JSON ('read'|'write')[]
  expires_at: string;
  authorization_json: string; // the signed VaultKeyAuthorization delegation (JSON)
  authorization_hash: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

/** Read the live (non-revoked) vault-key binding for an owner on this server, or null. */
export async function getVaultKeyBindingRow(
  db: D1Database,
  owner: string,
  serverId: string,
): Promise<VaultKeyBindingRow | null> {
  return (
    (await db
      .prepare(
        'SELECT * FROM vault_key_bindings WHERE owner_address = ? AND server_id = ? AND revoked_at IS NULL',
      )
      .bind(owner.toLowerCase(), serverId)
      .first<VaultKeyBindingRow>()) ?? null
  );
}

/** Upsert a vault-key binding (created by the connected-custodian ceremony, P5). */
export async function putVaultKeyBindingRow(
  db: D1Database,
  row: Omit<VaultKeyBindingRow, 'created_at' | 'updated_at' | 'revoked_at'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vault_key_bindings (owner_address, server_id, vault_id, kms_key_ref, allowed_resources, classification_ceiling, ops, expires_at, authorization_json, authorization_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_address, server_id) DO UPDATE SET
         vault_id = excluded.vault_id,
         kms_key_ref = excluded.kms_key_ref,
         allowed_resources = excluded.allowed_resources,
         classification_ceiling = excluded.classification_ceiling,
         ops = excluded.ops,
         expires_at = excluded.expires_at,
         authorization_json = excluded.authorization_json,
         authorization_hash = excluded.authorization_hash,
         updated_at = CURRENT_TIMESTAMP,
         revoked_at = NULL`,
    )
    .bind(
      row.owner_address.toLowerCase(),
      row.server_id,
      row.vault_id,
      row.kms_key_ref,
      row.allowed_resources,
      row.classification_ceiling,
      row.ops,
      row.expires_at,
      row.authorization_json,
      row.authorization_hash,
    )
    .run();
}

// ─── Durable signature-verdict cache (migration 0012) ────────────────────────
// Cross-isolate cache of POSITIVE + deployed delegation signature verdicts. A valid signature over a
// fixed digest is immutable and a deployed SA never un-deploys, so a verdict cached here is authoritative
// forever — it removes the per-op ERC-1271 RPC that made valid vault reads intermittently flake. Only
// `valid && deployed` verdicts are written (monotonic); revocation is checked live elsewhere.

/** True if this exact (signer, digest, signature) was already verified valid+deployed on-chain. */
export async function hasSigVerdict(db: D1Database, verdictKey: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM delegation_sig_verdicts WHERE verdict_key = ?')
    .bind(verdictKey)
    .first<{ ok: number }>();
  return row != null;
}

/** Record a positive+deployed verdict (idempotent). Best-effort; never overwrites. */
export async function putSigVerdict(db: D1Database, verdictKey: string, chainId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO delegation_sig_verdicts (verdict_key, chain_id) VALUES (?, ?)')
    .bind(verdictKey, chainId)
    .run();
}
