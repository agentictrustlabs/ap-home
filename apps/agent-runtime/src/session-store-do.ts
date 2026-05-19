// SessionStoreDO — Durable Object holding session rows for ONE user.
//
// Sharded per-user via idFromName(accountAddress). Each user's session
// storage lives in an isolated DO instance, so a hot user can't starve
// others' I/O budget. The accountAddress is the smart-account address
// (matches SessionRow.accountAddress), lowercased for stable hashing.
//
// SessionRow contains Uint8Array fields (encryptedPackage, iv, encryptedDataKey).
// DO storage supports structured-clone, but we transmit over HTTP (fetch
// between Worker and DO), so the wire format is JSON with hex strings for
// the binary fields. The DO converts back to Uint8Array before storage.

import type { SessionRow } from '@agenticprimitives/delegation';

interface StoredRow {
  id: string;
  accountAddress: string;
  chainId: number;
  sessionKeyAddress: string;
  status: 'pending' | 'active' | 'revoked' | 'expired';
  encryptedPackageHex: string;
  ivHex: string;
  encryptedDataKeyHex: string;
  keyVersion: string;
  expiresAt: string;
  variant?: 'A' | 'B';
  createdAt: string;
  revokedAt?: string;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function rowToStored(row: SessionRow): StoredRow {
  return {
    id: row.id,
    accountAddress: row.accountAddress,
    chainId: row.chainId,
    sessionKeyAddress: row.sessionKeyAddress,
    status: row.status,
    encryptedPackageHex: bytesToHex(row.encryptedPackage),
    ivHex: bytesToHex(row.iv),
    encryptedDataKeyHex: bytesToHex(row.encryptedDataKey),
    keyVersion: row.keyVersion,
    expiresAt: row.expiresAt,
    variant: row.variant,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function storedToRow(stored: StoredRow): SessionRow {
  return {
    id: stored.id,
    accountAddress: stored.accountAddress as `0x${string}`,
    chainId: stored.chainId,
    sessionKeyAddress: stored.sessionKeyAddress as `0x${string}`,
    status: stored.status,
    encryptedPackage: hexToBytes(stored.encryptedPackageHex),
    iv: hexToBytes(stored.ivHex),
    encryptedDataKey: hexToBytes(stored.encryptedDataKeyHex),
    keyVersion: stored.keyVersion,
    expiresAt: stored.expiresAt,
    variant: stored.variant,
    createdAt: stored.createdAt,
    revokedAt: stored.revokedAt,
  };
}

export class SessionStoreDO {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case '/save': {
          const stored = (await req.json()) as StoredRow;
          await this.state.storage.put(stored.id, stored);
          return Response.json({ ok: true });
        }
        case '/get': {
          const id = url.searchParams.get('id');
          if (!id) return Response.json({ error: 'id required' }, { status: 400 });
          const stored = (await this.state.storage.get(id)) as StoredRow | undefined;
          return Response.json(stored ?? null);
        }
        case '/list': {
          const accountAddress = url.searchParams.get('accountAddress');
          if (!accountAddress) return Response.json({ error: 'accountAddress required' }, { status: 400 });
          const all = await this.state.storage.list<StoredRow>();
          const rows: StoredRow[] = [];
          const needle = accountAddress.toLowerCase();
          for (const v of all.values()) {
            if (v.accountAddress.toLowerCase() === needle) rows.push(v);
          }
          return Response.json(rows);
        }
        case '/revoke': {
          const id = url.searchParams.get('id');
          if (!id) return Response.json({ error: 'id required' }, { status: 400 });
          const stored = (await this.state.storage.get(id)) as StoredRow | undefined;
          if (!stored) return Response.json({ ok: true });
          stored.status = 'revoked';
          stored.revokedAt = new Date().toISOString();
          await this.state.storage.put(id, stored);
          return Response.json({ ok: true });
        }
        default:
          return Response.json({ error: 'not found' }, { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: 'do error', detail: String(e) }, { status: 500 });
    }
  }
}

// ─── Adapter for delegation.SessionStore that talks to the DO ─────────────

export class DurableObjectSessionStore {
  private readonly doName: string;

  /**
   * @param namespace      The DurableObjectNamespace binding (env.SESSIONS).
   * @param accountAddress The smart-account address that owns this user's
   *                       sessions. Used to derive the DO instance name via
   *                       idFromName(accountAddress.toLowerCase()), giving
   *                       each user an isolated DO. Required.
   */
  constructor(private namespace: DurableObjectNamespace, accountAddress: string) {
    if (!accountAddress || !accountAddress.startsWith('0x')) {
      throw new Error(
        `DurableObjectSessionStore: accountAddress (0x-prefixed) is required for per-user sharding. Got: ${accountAddress}`,
      );
    }
    this.doName = accountAddress.toLowerCase();
  }

  private stub() {
    const id = this.namespace.idFromName(this.doName);
    return this.namespace.get(id);
  }

  async save(row: SessionRow): Promise<void> {
    const res = await this.stub().fetch('https://internal/save', {
      method: 'POST',
      body: JSON.stringify(rowToStored(row)),
      headers: { 'content-type': 'application/json' },
    });
    if (!res.ok) throw new Error(`DO save failed: ${res.status}`);
  }

  async get(id: string): Promise<SessionRow | null> {
    const res = await this.stub().fetch(`https://internal/get?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`DO get failed: ${res.status}`);
    const stored = (await res.json()) as StoredRow | null;
    return stored ? storedToRow(stored) : null;
  }

  async list(accountAddress: string): Promise<SessionRow[]> {
    const res = await this.stub().fetch(
      `https://internal/list?accountAddress=${encodeURIComponent(accountAddress)}`,
    );
    if (!res.ok) throw new Error(`DO list failed: ${res.status}`);
    const stored = (await res.json()) as StoredRow[];
    return stored.map(storedToRow);
  }

  async revoke(id: string): Promise<void> {
    const res = await this.stub().fetch(`https://internal/revoke?id=${encodeURIComponent(id)}`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`DO revoke failed: ${res.status}`);
  }
}
