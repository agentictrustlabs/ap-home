// PAIRING CODES (spec 400 W1b) — the rendezvous between a runtime on someone's machine and the custodian's Home,
// kept on the custodian's OWN agent object. A code is minutes-lived, single use and grants nothing: it lets a
// runtime SAY which key it generated and TAKE the record the custodian's browser equipped for that key — every
// signature in that record is the custodian's, revocable on chain. DO-local by nature (a pairing is a moment, not a
// record: wiping it loses a code, never a grant).
//
// States: minted → claimed (the runtime named its key) → completed (the Home wrote the record) → taken (the runtime
// read it once). A code can only move forward; a claim by a second key, or a take by a key the record does not name,
// is refused.
export const PAIRING_KEY = (code: string): string => `runtime.pairing:${code}`;
export const PAIRING_INDEX_KEY = 'runtime.pairings';
export const PAIRING_TTL_MS = 15 * 60_000;
/** After completion the record waits this long for the runtime to take it, then the code expires with it. */
export const PAIRING_TAKE_TTL_MS = 10 * 60_000;
export const PAIRING_CAP = 20;
export const PAIRING_CODE_RE = /^([a-z0-9][a-z0-9-]{0,62})-([A-HJ-NP-Z2-9]{6})$/;

export interface PairingOptionsV1 { member: string; workspace: string; validForSeconds: number; openMandate: string[]; messagingTo: string[]; wake: 'container' | 'poll' | { url: string } }
export interface PairingClaimV1 { address: string; wake?: unknown; agent?: string; claimedAt: string }
export type PairingStateV1 =
  | { v: 1; code: string; state: 'minted'; options: PairingOptionsV1; mintedAt: string; expiresAt: string }
  | { v: 1; code: string; state: 'claimed'; options: PairingOptionsV1; mintedAt: string; expiresAt: string; claim: PairingClaimV1 }
  | { v: 1; code: string; state: 'completed'; options: PairingOptionsV1; mintedAt: string; expiresAt: string; claim: PairingClaimV1; record: Record<string, unknown> & { address: string }; completedAt: string }
  | { v: 1; code: string; state: 'taken'; options: PairingOptionsV1; mintedAt: string; expiresAt: string; claim: PairingClaimV1; completedAt: string; takenAt: string };

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — read aloud, typed once
export function mintCode(handle: string, random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const label = handle.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z0-9-]/g, '');
  const bytes = random(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return `${label}-${s}`;
}

export function parsePairingOptions(o: unknown): PairingOptionsV1 | null {
  if (!o || typeof o !== 'object') return null;
  const b = o as Record<string, unknown>;
  const member = String(b.member ?? '').trim().toLowerCase();
  const workspace = String(b.workspace ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.svc$/.test(member)) return null;
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z]+$/.test(workspace)) return null;
  const validForSeconds = Number(b.validForSeconds ?? 30 * 86_400);
  if (!Number.isFinite(validForSeconds) || validForSeconds < 3600 || validForSeconds > 365 * 86_400) return null;
  const openMandate = Array.isArray(b.openMandate) ? (b.openMandate as unknown[]).map(String).filter((x) => /^[a-z0-9.]+$/.test(x)) : [];
  const messagingTo = Array.isArray(b.messagingTo) ? (b.messagingTo as unknown[]).map((x) => String(x).toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x)) : [];
  const w = b.wake;
  const wake: PairingOptionsV1['wake'] | null = w === 'container' || w === 'poll' ? w : (w && typeof w === 'object' && typeof (w as { url?: unknown }).url === 'string' && /^https?:\/\//.test(String((w as { url: string }).url))) ? { url: String((w as { url: string }).url).replace(/\/$/, '') } : w === undefined ? 'poll' : null;
  if (!wake) return null;
  return { member, workspace, validForSeconds, openMandate, messagingTo, wake };
}

export const isExpired = (p: PairingStateV1, now = Date.now()): boolean =>
  p.state === 'completed' ? now > Date.parse(p.completedAt) + PAIRING_TAKE_TTL_MS : p.state === 'taken' ? true : now > Date.parse(p.expiresAt);

/** The runtime's claim: a fresh code takes the first key it hears; the same key may re-claim (a retry); another is refused. */
export function claim(p: PairingStateV1, c: { address: string; wake?: unknown; agent?: string }, now = Date.now()): { ok: true; next: PairingStateV1 } | { ok: false; error: string } {
  if (isExpired(p, now)) return { ok: false, error: 'this code has expired — mint a new one at the Home' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.address)) return { ok: false, error: 'a key address is required' };
  const address = c.address.toLowerCase();
  if (p.state === 'claimed' || p.state === 'completed' || p.state === 'taken') {
    if (p.claim.address !== address) return { ok: false, error: 'this code was already claimed by another key' };
    return { ok: true, next: p };
  }
  return { ok: true, next: { ...p, state: 'claimed', claim: { address, claimedAt: new Date(now).toISOString(), ...(c.wake !== undefined ? { wake: c.wake } : {}), ...(c.agent ? { agent: String(c.agent).slice(0, 80) } : {}) } } };
}

/** The Home's completion: the record must name the claimed key. */
export function complete(p: PairingStateV1, record: unknown, now = Date.now()): { ok: true; next: PairingStateV1 } | { ok: false; error: string } {
  if (p.state !== 'claimed') return { ok: false, error: `a ${p.state} code cannot be completed` };
  if (isExpired(p, now)) return { ok: false, error: 'this code has expired' };
  const r = record as { address?: unknown } | null;
  if (!r || typeof r !== 'object' || String(r.address ?? '').toLowerCase() !== p.claim.address) return { ok: false, error: 'the record must name the claimed key' };
  return { ok: true, next: { ...p, state: 'completed', record: r as Record<string, unknown> & { address: string }, completedAt: new Date(now).toISOString() } };
}

/** The runtime's take: once, by the claimed key; the record leaves the object with it. */
export function take(p: PairingStateV1, address: string, now = Date.now()): { ok: true; state: PairingStateV1['state']; record?: Record<string, unknown>; next?: PairingStateV1 } | { ok: false; error: string } {
  if (p.state === 'taken') return { ok: false, error: 'this record was already taken' };
  if (isExpired(p, now)) return { ok: false, error: 'this code has expired — mint a new one at the Home' };
  if (p.state === 'minted') return { ok: true, state: 'minted' };
  if (p.claim.address !== address.toLowerCase()) return { ok: false, error: 'not the key that claimed this code' };
  if (p.state === 'claimed') return { ok: true, state: 'claimed' };
  const { record, ...rest } = p;
  return { ok: true, state: 'completed', record, next: { ...rest, state: 'taken', takenAt: new Date(now).toISOString() } };
}
