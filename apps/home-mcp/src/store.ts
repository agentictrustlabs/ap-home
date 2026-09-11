// THE STORE — one Durable Object for the Home MCP's OAuth state and the persons who connected. Rows are the
// authorization-server's own (client registrations, pending authorizations, codes, tokens) plus, per person, the
// ask-as-me wire the Home minted for the Home MCP's key. The wire is encrypted with a Worker-held KEK: a wiped
// object is a re-connect, never a bereavement (ADR-0055 — the delegation of record is on chain, revocable there).
import type { DelegationWireV1 } from '@agenticprimitives/a2a';

export interface ClientRow { client_id: string; client_secret_hash?: string; redirect_uris: string[]; client_name?: string; token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic'; created_at: number }
export interface PendingRow { id: string; client_id: string; redirect_uri: string; state?: string; code_challenge: string; scope: string[]; resource: string; home_verifier: string; home_state: string; created_at: number }
export interface CodeRow { code: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string[]; resource: string; sub: string; created_at: number }
export interface TokenRow { token_hash: string; kind: 'access' | 'refresh'; client_id: string; sub: string; scope: string[]; resource: string; exp: number; refresh_of?: string; created_at: number }
export interface PersonRow { sub: string; agent: string; agent_name?: string; wire_enc: string; wire_iv: string; wire_ref: string; connected_at: number; client_ids: string[] }

export class HomeMcpStoreDO {
  private readonly sql: SqlStorage;
  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, row TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, row TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, row TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, row TEXT NOT NULL, exp INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS persons (sub TEXT PRIMARY KEY, row TEXT NOT NULL)`);
  }
  async fetch(request: Request): Promise<Response> {
    const { op, key, row, ttlMs } = (await request.json()) as { op: string; key?: string; row?: unknown; ttlMs?: number };
    const now = Date.now();
    const json = (b: unknown) => Response.json(b);
    switch (op) {
      case 'client.put': this.sql.exec(`INSERT OR REPLACE INTO clients (client_id, row) VALUES (?, ?)`, key, JSON.stringify(row)); return json({ ok: true });
      case 'client.get': { const r = [...this.sql.exec(`SELECT row FROM clients WHERE client_id = ?`, key)][0]; return json({ ok: true, row: r ? JSON.parse(String(r.row)) : null }); }
      case 'pending.put': this.sql.exec(`INSERT OR REPLACE INTO pending (id, row, created_at) VALUES (?, ?, ?)`, key, JSON.stringify(row), now); return json({ ok: true });
      case 'pending.take': { const r = [...this.sql.exec(`SELECT row, created_at FROM pending WHERE id = ?`, key)][0]; this.sql.exec(`DELETE FROM pending WHERE id = ?`, key); if (!r || now - Number(r.created_at) > (ttlMs ?? 600_000)) return json({ ok: true, row: null }); return json({ ok: true, row: JSON.parse(String(r.row)) }); }
      case 'code.put': this.sql.exec(`INSERT OR REPLACE INTO codes (code, row, created_at) VALUES (?, ?, ?)`, key, JSON.stringify(row), now); return json({ ok: true });
      case 'code.take': { const r = [...this.sql.exec(`SELECT row, created_at FROM codes WHERE code = ?`, key)][0]; this.sql.exec(`DELETE FROM codes WHERE code = ?`, key); if (!r || now - Number(r.created_at) > (ttlMs ?? 300_000)) return json({ ok: true, row: null }); return json({ ok: true, row: JSON.parse(String(r.row)) }); }
      case 'token.put': { const t = row as TokenRow; this.sql.exec(`INSERT OR REPLACE INTO tokens (token_hash, row, exp) VALUES (?, ?, ?)`, key, JSON.stringify(t), t.exp); this.sql.exec(`DELETE FROM tokens WHERE exp < ?`, now); return json({ ok: true }); }
      case 'token.get': { const r = [...this.sql.exec(`SELECT row, exp FROM tokens WHERE token_hash = ?`, key)][0]; if (!r || Number(r.exp) < now) return json({ ok: true, row: null }); return json({ ok: true, row: JSON.parse(String(r.row)) }); }
      case 'token.delete': this.sql.exec(`DELETE FROM tokens WHERE token_hash = ?`, key); return json({ ok: true });
      case 'token.deleteFor': { const r = row as { sub: string; client_id?: string }; for (const x of [...this.sql.exec(`SELECT token_hash, row FROM tokens`)]) { const t = JSON.parse(String(x.row)) as TokenRow; if (t.sub === r.sub && (!r.client_id || t.client_id === r.client_id)) this.sql.exec(`DELETE FROM tokens WHERE token_hash = ?`, x.token_hash); } return json({ ok: true }); }
      case 'person.put': this.sql.exec(`INSERT OR REPLACE INTO persons (sub, row) VALUES (?, ?)`, key, JSON.stringify(row)); return json({ ok: true });
      case 'person.get': { const r = [...this.sql.exec(`SELECT row FROM persons WHERE sub = ?`, key)][0]; return json({ ok: true, row: r ? JSON.parse(String(r.row)) : null }); }
      case 'person.delete': this.sql.exec(`DELETE FROM persons WHERE sub = ?`, key); return json({ ok: true });
      default: return json({ ok: false, error: `unknown op ${op}` }, );
    }
  }
}

/** The one client-side handle over the object. */
export class Store {
  constructor(private readonly stub: DurableObjectStub) {}
  private async call<T = unknown>(op: string, key?: string, row?: unknown, ttlMs?: number): Promise<T> {
    const res = await this.stub.fetch(new Request('https://store/', { method: 'POST', body: JSON.stringify({ op, key, row, ttlMs }) }));
    return (await res.json()) as T;
  }
  putClient(r: ClientRow) { return this.call('client.put', r.client_id, r); }
  async getClient(id: string): Promise<ClientRow | null> { return (await this.call<{ row: ClientRow | null }>('client.get', id)).row; }
  putPending(r: PendingRow) { return this.call('pending.put', r.id, r); }
  async takePending(id: string): Promise<PendingRow | null> { return (await this.call<{ row: PendingRow | null }>('pending.take', id)).row; }
  putCode(r: CodeRow) { return this.call('code.put', r.code, r); }
  async takeCode(code: string): Promise<CodeRow | null> { return (await this.call<{ row: CodeRow | null }>('code.take', code)).row; }
  putToken(hash: string, r: TokenRow) { return this.call('token.put', hash, r); }
  async getToken(hash: string): Promise<TokenRow | null> { return (await this.call<{ row: TokenRow | null }>('token.get', hash)).row; }
  deleteToken(hash: string) { return this.call('token.delete', hash); }
  deleteTokensFor(sub: string, client_id?: string) { return this.call('token.deleteFor', undefined, { sub, client_id }); }
  putPerson(r: PersonRow) { return this.call('person.put', r.sub, r); }
  async getPerson(sub: string): Promise<PersonRow | null> { return (await this.call<{ row: PersonRow | null }>('person.get', sub)).row; }
  deletePerson(sub: string) { return this.call('person.delete', sub); }
}

/** The wire at rest: AES-GCM under a Worker-held KEK, never plaintext in the object. */
export async function sealWire(kek: CryptoKey, wire: DelegationWireV1): Promise<{ enc: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode(JSON.stringify(wire)));
  return { enc: b64(new Uint8Array(ct)), iv: b64(iv) };
}
export async function openWire(kek: CryptoKey, enc: string, iv: string): Promise<DelegationWireV1> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, kek, unb64(enc));
  return JSON.parse(new TextDecoder().decode(pt)) as DelegationWireV1;
}
export async function kekFrom(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`home-mcp-kek:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const randomToken = (bytes = 32): string => b64(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256b64(s: string): Promise<string> { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
