// Spec 410 §1.2 step 5 — the move ticket: what the old Home accepts, and what it refuses by name.
import { describe, it, expect } from 'vitest';
import { parseMoveTicket, encodeTicket, ticketRefToCredentialRef, type MoveTicketV1 } from './move';
import { CHAIN_ID } from '../lib/chain';

const AGENT = '0x0a60000000000000000000000000000000000001' as const;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const ticket: MoveTicketV1 = { type: 'ap.home-move-ticket.v1', home: 'https://home-b.example', chainId: CHAIN_ID, agent: AGENT, ref: { kind: 'passkey', credentialIdDigest: h(0x11), x: h(0x22), y: h(0x33), rpIdHash: h(0x44) }, mintedAt: '2026-09-20T12:00:00Z' };
const here = { agent: AGENT, origin: 'https://home-a.example' };

describe('the move ticket at the old Home', () => {
  it('accepts a passkey for this person on this chain from another Home, encoded or plain, and turns its key into the SDK ref', () => {
    const p = parseMoveTicket(encodeTicket(ticket), here);
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.ticket.home).toBe('https://home-b.example');
    expect(parseMoveTicket(JSON.stringify(ticket), here).ok).toBe(true);
    expect(ticketRefToCredentialRef(p.ticket.ref)).toEqual({ kind: 'passkey', credentialIdDigest: h(0x11), x: 0x22n, y: 0x33n, rpIdHash: h(0x44) });
  });
  it('refuses by name: another person, another chain, this same Home, a non-https Home, garbage, a malformed key', () => {
    expect(parseMoveTicket(encodeTicket(ticket), { ...here, agent: '0x0a60000000000000000000000000000000000002' })).toMatchObject({ ok: false, error: expect.stringMatching(/different agent/) });
    expect(parseMoveTicket(encodeTicket({ ...ticket, chainId: CHAIN_ID + 1 }), here)).toMatchObject({ ok: false, error: expect.stringMatching(/chain/) });
    expect(parseMoveTicket(encodeTicket({ ...ticket, home: 'https://home-a.example' }), here)).toMatchObject({ ok: false, error: expect.stringMatching(/from this Home/) });
    expect(parseMoveTicket(encodeTicket({ ...ticket, home: 'http://evil.example' }), here)).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(parseMoveTicket('not a ticket', here)).toMatchObject({ ok: false });
    expect(parseMoveTicket(encodeTicket({ ...ticket, ref: { ...ticket.ref, x: '0x12' as never } }), here)).toMatchObject({ ok: false, error: expect.stringMatching(/malformed/) });
  });
});
