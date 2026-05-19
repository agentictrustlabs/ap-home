// D1-backed profile + JTI access.
//
// Replaces the better-sqlite3 db from the Node version. Same SQL shape;
// same INSERT … ON CONFLICT … RETURNING atomic pattern for JTI.

import type { JtiStore } from '@agenticprimitives/delegation';

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
