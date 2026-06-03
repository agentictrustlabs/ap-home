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

export async function upsertDemoProfile(db: D1Database, address: string): Promise<Profile> {
  const addr = address.toLowerCase();
  const existing = await db
    .prepare('SELECT * FROM profiles WHERE owner_address = ?')
    .bind(addr)
    .first<Profile>();
  if (existing) return existing;

  const seeded: Profile = {
    owner_address: addr,
    full_name: `Demo User (${address.slice(0, 6)}…${address.slice(-4)})`,
    email: `${address.slice(2, 10)}@demo.agenticprimitives.local`,
    phone: '+1-555-0100',
    notes: 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO profiles (owner_address, full_name, email, phone, notes) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(seeded.owner_address, seeded.full_name, seeded.email, seeded.phone, seeded.notes)
    .run();
  return seeded;
}

export async function getProfile(db: D1Database, address: string): Promise<Profile | undefined> {
  const row = await db
    .prepare('SELECT * FROM profiles WHERE owner_address = ?')
    .bind(address.toLowerCase())
    .first<Profile>();
  return row ?? undefined;
}

// JtiStore backed by D1. INSERT…ON CONFLICT…RETURNING gives us atomic
// increment-and-read per spec 205 §5.
export function createD1JtiStore(db: D1Database, table: string = 'token_usage'): JtiStore {
  return {
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

// ─── Person PII + Org sensitive (phase 6f.6) ──────────────────────────

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

export async function upsertDemoPii(
  db: D1Database,
  subject: string,
  fields?: Partial<Omit<PersonPii, 'subject_address' | 'updated_at'>>,
): Promise<PersonPii> {
  const addr = subject.toLowerCase();
  const existing = await db
    .prepare('SELECT * FROM person_pii WHERE subject_address = ?')
    .bind(addr)
    .first<PersonPii>();
  if (existing && !fields) return existing;
  const seeded: PersonPii = {
    subject_address: addr,
    full_name: fields?.full_name ?? `Demo Person (${subject.slice(0, 6)}…${subject.slice(-4)})`,
    email: fields?.email ?? `${subject.slice(2, 10).toLowerCase()}@demo.agenticprimitives.local`,
    phone: fields?.phone ?? '+1-555-0142',
    dob: fields?.dob ?? '1985-06-15',
    ssn_last4: fields?.ssn_last4 ?? subject.slice(-4),
    postal_address: fields?.postal_address ?? '1 Demo Way, Springfield, IL 62701',
    notes: fields?.notes ?? 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO person_pii (subject_address, full_name, email, phone, dob, ssn_last4, postal_address, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_address) DO UPDATE SET
         full_name = excluded.full_name,
         email = excluded.email,
         phone = excluded.phone,
         dob = excluded.dob,
         ssn_last4 = excluded.ssn_last4,
         postal_address = excluded.postal_address,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      seeded.subject_address,
      seeded.full_name,
      seeded.email,
      seeded.phone,
      seeded.dob,
      seeded.ssn_last4,
      seeded.postal_address,
      seeded.notes,
    )
    .run();
  return seeded;
}

export async function getPii(db: D1Database, subject: string): Promise<PersonPii | undefined> {
  return (
    (await db
      .prepare('SELECT * FROM person_pii WHERE subject_address = ?')
      .bind(subject.toLowerCase())
      .first<PersonPii>()) ?? undefined
  );
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

export async function upsertDemoOrgSensitive(
  db: D1Database,
  orgAddress: string,
  fields?: Partial<Omit<OrgSensitive, 'org_address' | 'updated_at'>>,
): Promise<OrgSensitive> {
  const addr = orgAddress.toLowerCase();
  const existing = await db
    .prepare('SELECT * FROM org_sensitive WHERE org_address = ?')
    .bind(addr)
    .first<OrgSensitive>();
  if (existing && !fields) return existing;
  const seeded: OrgSensitive = {
    org_address: addr,
    legal_name: fields?.legal_name ?? 'Acme Construction LLC',
    ein: fields?.ein ?? '87-4421099',
    incorporated_in: fields?.incorporated_in ?? 'Delaware',
    ytd_revenue_usd: fields?.ytd_revenue_usd ?? 12_840_000,
    active_contracts: fields?.active_contracts ?? 14,
    pending_litigation: fields?.pending_litigation ?? 0,
    primary_banking: fields?.primary_banking ?? 'Chase Business · acct ****8821',
    notes: fields?.notes ?? 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO org_sensitive (org_address, legal_name, ein, incorporated_in, ytd_revenue_usd, active_contracts, pending_litigation, primary_banking, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_address) DO UPDATE SET
         legal_name = excluded.legal_name,
         ein = excluded.ein,
         incorporated_in = excluded.incorporated_in,
         ytd_revenue_usd = excluded.ytd_revenue_usd,
         active_contracts = excluded.active_contracts,
         pending_litigation = excluded.pending_litigation,
         primary_banking = excluded.primary_banking,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      seeded.org_address,
      seeded.legal_name,
      seeded.ein,
      seeded.incorporated_in,
      seeded.ytd_revenue_usd,
      seeded.active_contracts,
      seeded.pending_litigation,
      seeded.primary_banking,
      seeded.notes,
    )
    .run();
  return seeded;
}

export async function getOrgSensitive(
  db: D1Database,
  orgAddress: string,
): Promise<OrgSensitive | undefined> {
  return (
    (await db
      .prepare('SELECT * FROM org_sensitive WHERE org_address = ?')
      .bind(orgAddress.toLowerCase())
      .first<OrgSensitive>()) ?? undefined
  );
}

// ─── Generic per-agent vault (spec 247) ───────────────────────────────
//
// Arbitrary JSON keyed by (owner_address, record_type). `owner` is always
// the recovered delegation principal at the call site, so these helpers
// never key by anything but the agent acting on its OWN namespace.

/** Read one live record; `null` when absent or tombstoned. */
export async function getVaultRecord(
  db: D1Database,
  owner: string,
  recordType: string,
): Promise<unknown | null> {
  const row = await db
    .prepare(
      'SELECT data_json FROM vault_records WHERE owner_address = ? AND record_type = ? AND deleted_at IS NULL',
    )
    .bind(owner.toLowerCase(), recordType)
    .first<{ data_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.data_json);
  } catch {
    return null;
  }
}

/** Upsert a record. `data === null|undefined` soft-deletes (tombstone). */
export async function setVaultRecord(
  db: D1Database,
  owner: string,
  recordType: string,
  data: unknown,
): Promise<void> {
  if (data === null || data === undefined) {
    await db
      .prepare(
        'UPDATE vault_records SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE owner_address = ? AND record_type = ?',
      )
      .bind(owner.toLowerCase(), recordType)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO vault_records (owner_address, record_type, data_json) VALUES (?, ?, ?)
       ON CONFLICT(owner_address, record_type) DO UPDATE SET
         data_json = excluded.data_json,
         updated_at = CURRENT_TIMESTAMP,
         deleted_at = NULL`,
    )
    .bind(owner.toLowerCase(), recordType, JSON.stringify(data))
    .run();
}

/** Enumerate the owner's live record types (no payloads). */
export async function listVaultRecords(
  db: D1Database,
  owner: string,
): Promise<Array<{ record_type: string; updated_at: string }>> {
  const res = await db
    .prepare(
      'SELECT record_type, updated_at FROM vault_records WHERE owner_address = ? AND deleted_at IS NULL ORDER BY record_type',
    )
    .bind(owner.toLowerCase())
    .all<{ record_type: string; updated_at: string }>();
  return res.results ?? [];
}
