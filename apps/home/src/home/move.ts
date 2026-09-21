// A HOME-TO-HOME MOVE IS A ROTATION — spec 410 §1.2 step 5 (THESIS-1). Spec 406 W3 carries the RECORDS; this carries
// the AUTHORITY. A passkey is scoped to its relying-party domain (spec 321), so a new Home cannot use the old one's:
// the new Home registers a passkey of its own and the move is `add(new-domain passkey) → retire(old) → reapprove`,
// signed ONCE at the old Home by the old credential — the same ceremony as replacing a device, with the new key
// coming from elsewhere. It is never a recovery: nothing was lost, and the new Home is trusted with a PUBLIC KEY and
// nothing else.
//
//   at the NEW Home  — `mintMoveTicket`: create the passkey here (its rpId is this Home's), remember which agent it
//                      is for, and hand the person a TICKET: the public key, the credential-id digest, this Home's
//                      origin and chain. No secret leaves the device; the ticket is safe to paste anywhere.
//   at the OLD Home  — `parseMoveTicket` checks it (this chain, this person, a passkey, a foreign origin); the
//                      Security page runs `rotateThisDevicePasskey({ add: ticket.ref })` over the reviewed list.
//   at the NEW Home  — `claimMovedPasskey`: once the chain holds the passkey, the Home indexes passkey → agent so
//                      sign-in resolves it (`/connect/passkey/claim`, gated by the on-chain fact alone), and the
//                      person signs in with the new passkey. Then spec 406 W3 carries her records.
import type { Address, Hex } from '@agenticprimitives/types';
import { registerPasskeyCredentialRef } from '../connect-client';
import { CHAIN_ID } from '../lib/chain';
import type { DemoPasskey } from '../lib/passkey';

export interface MoveTicketV1 {
  type: 'ap.home-move-ticket.v1';
  /** The Home the passkey belongs to (its origin) — where the person will sign in afterwards. */
  home: string;
  chainId: number;
  /** The agent this move is for: the ticket is refused at any other person's old Home. */
  agent: Address;
  /** What the old Home adds: the passkey's public key (as hex), credential-id digest and the new Home's rpId hash. */
  ref: { kind: 'passkey'; credentialIdDigest: Hex; x: Hex; y: Hex; rpIdHash: Hex };
  mintedAt: string;
}
/** The ticket's passkey as the account SDK takes it (`CredentialRef`): the coordinates as bigints. */
export type PasskeyCredentialRef = { kind: 'passkey'; credentialIdDigest: Hex; x: bigint; y: bigint; rpIdHash: Hex };
const toHex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export const ticketRefToCredentialRef = (r: MoveTicketV1['ref']): PasskeyCredentialRef => ({ kind: 'passkey', credentialIdDigest: r.credentialIdDigest, x: BigInt(r.x), y: BigInt(r.y), rpIdHash: r.rpIdHash });

const PENDING_KEY = 'ap.home-move.pending';

/** At the NEW Home: create the passkey here and mint the ticket; the pending move is remembered on this device. */
export async function mintMoveTicket(agent: Address, label: string): Promise<{ ticket: MoveTicketV1; encoded: string; passkey: DemoPasskey }> {
  const fresh = await registerPasskeyCredentialRef(label);
  const ticket: MoveTicketV1 = { type: 'ap.home-move-ticket.v1', home: window.location.origin, chainId: CHAIN_ID, agent: agent.toLowerCase() as Address, ref: { kind: 'passkey', credentialIdDigest: fresh.ref.credentialIdDigest, x: toHex32(fresh.ref.x), y: toHex32(fresh.ref.y), rpIdHash: fresh.ref.rpIdHash }, mintedAt: new Date().toISOString() };
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ agent: ticket.agent, credentialIdDigest: fresh.passkey.credentialIdDigest, mintedAt: ticket.mintedAt })); } catch { /* a private window: the person keeps the ticket */ }
  return { ticket, encoded: encodeTicket(ticket), passkey: fresh.passkey };
}
export const encodeTicket = (t: MoveTicketV1): string => btoa(unescape(encodeURIComponent(JSON.stringify(t)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** At the OLD Home: read a pasted ticket and refuse anything but a passkey for THIS person on THIS chain from ANOTHER origin. */
export function parseMoveTicket(text: string, expect: { agent: Address; origin: string }): { ok: true; ticket: MoveTicketV1 } | { ok: false; error: string } {
  let t: MoveTicketV1;
  try {
    const raw = text.trim();
    const json = raw.startsWith('{') ? raw : decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4))));
    t = JSON.parse(json) as MoveTicketV1;
  } catch { return { ok: false, error: 'that is not a move ticket' }; }
  if (t?.type !== 'ap.home-move-ticket.v1' || t.ref?.kind !== 'passkey') return { ok: false, error: 'that is not a move ticket (a passkey for another Home)' };
  const hex = (v: unknown, n: number) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
  if (!hex(t.ref.credentialIdDigest, 64) || !hex(t.ref.x, 64) || !hex(t.ref.y, 64) || !hex(t.ref.rpIdHash, 64)) return { ok: false, error: 'the ticket\'s passkey is malformed' };
  if (Number(t.chainId) !== CHAIN_ID) return { ok: false, error: `the ticket is for chain ${t.chainId}; this Home is chain ${CHAIN_ID} — a move between estates is spec 410 §4.4, not this` };
  if (String(t.agent).toLowerCase() !== expect.agent.toLowerCase()) return { ok: false, error: 'the ticket was minted for a different agent — it can only move the person it names' };
  let home: URL; try { home = new URL(t.home); } catch { return { ok: false, error: 'the ticket names no Home' }; }
  if (home.origin === expect.origin) return { ok: false, error: 'the ticket is from this Home — to replace this device\'s passkey, use "Replace this device\'s passkey"' };
  if (home.protocol !== 'https:' && home.hostname !== 'localhost') return { ok: false, error: 'a Home is reached over https' };
  return { ok: true, ticket: { ...t, agent: t.agent.toLowerCase() as Address } };
}

/** At the NEW Home, after the old one rotated: the pending move on this device, if any. */
export function pendingMove(): { agent: Address; credentialIdDigest: Hex; mintedAt: string } | null {
  try { const raw = localStorage.getItem(PENDING_KEY); return raw ? (JSON.parse(raw) as { agent: Address; credentialIdDigest: Hex; mintedAt: string }) : null; } catch { return null; }
}
export function forgetPendingMove(): void { try { localStorage.removeItem(PENDING_KEY); } catch { /* nothing to forget */ } }

/** Index passkey → agent here once the chain holds it; refused until it does (never on a promise). */
export async function claimMovedPasskey(agent: Address, credentialIdDigest: Hex): Promise<{ ok: true } | { ok: false; error: string; notYet?: boolean }> {
  const r = await fetch('/connect/passkey/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, credentialIdDigest }) });
  const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (r.ok && b.ok) return { ok: true };
  return { ok: false, error: b.error ?? `HTTP ${r.status}`, ...(r.status === 409 ? { notYet: true } : {}) };
}
