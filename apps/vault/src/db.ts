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
