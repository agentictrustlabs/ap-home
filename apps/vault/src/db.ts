// Simple SQLite store for demo PII. Holds one row per smart-account principal.

import Database, { type Database as DatabaseType } from 'better-sqlite3';

const DB_PATH = process.env.MCP_DB_PATH ?? './demo-mcp.db';

export const db: DatabaseType = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    owner_address TEXT PRIMARY KEY,
    full_name     TEXT NOT NULL,
    email         TEXT NOT NULL,
    phone         TEXT,
    notes         TEXT,
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    jti        TEXT PRIMARY KEY,
    usage      INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

export interface Profile {
  owner_address: string;
  full_name: string;
  email: string;
  phone: string | null;
  notes: string | null;
  updated_at: string;
}

export function upsertDemoProfile(address: string): Profile {
  // Seed deterministic demo data on first call for an address.
  const existing = db.prepare('SELECT * FROM profiles WHERE owner_address = ?').get(address.toLowerCase()) as Profile | undefined;
  if (existing) return existing;
  const seeded: Profile = {
    owner_address: address.toLowerCase(),
    full_name: `Demo User (${address.slice(0, 6)}…${address.slice(-4)})`,
    email: `${address.slice(2, 10)}@demo.agenticprimitives.local`,
    phone: '+1-555-0100',
    notes: 'Seeded by demo-mcp.',
    updated_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO profiles (owner_address, full_name, email, phone, notes) VALUES (?, ?, ?, ?, ?)`,
  ).run(seeded.owner_address, seeded.full_name, seeded.email, seeded.phone, seeded.notes);
  return seeded;
}

export function getProfile(address: string): Profile | undefined {
  return db.prepare('SELECT * FROM profiles WHERE owner_address = ?').get(address.toLowerCase()) as Profile | undefined;
}
