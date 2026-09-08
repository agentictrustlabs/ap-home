// The /choose-treasury contract — the two decisions that are either right or an open redirect.
//
// The behaviour that matters most: a redirect_uri that is CLOSE to a registered one must fail, and
// `state` must come back exactly as it went out — including when it is empty or full of characters
// that mean something in a query string.

import { describe, expect, it } from 'vitest';
import {
  parseTreasuryRequest,
  refusalFor,
  treasuryReturnUrl,
  type TreasuryCeremonyClient,
} from './treasury-ceremony';

const POKER: TreasuryCeremonyClient = {
  client_id: 'pokernight',
  name: 'Poker Night',
  redirect_uris: ['https://poker.faithnet.io/', 'http://localhost:5173/'],
};

const req = (qs: string) => parseTreasuryRequest(`https://www.example.me/choose-treasury?${qs}`);

describe('parseTreasuryRequest', () => {
  it('reads client_id, redirect_uri, state and label', () => {
    const r = req('client_id=pokernight&redirect_uri=https%3A%2F%2Fpoker.faithnet.io%2F&state=s1&label=Poker%20Funds');
    expect(r).toEqual({
      clientId: 'pokernight',
      redirectUri: 'https://poker.faithnet.io/',
      state: 's1',
      label: 'Poker Funds',
    });
  });

  it('defaults state and label to empty — neither is required to make a request', () => {
    const r = req('client_id=pokernight&redirect_uri=https%3A%2F%2Fpoker.faithnet.io%2F');
    expect(r?.state).toBe('');
    expect(r?.label).toBe('');
  });

  it('returns null without a client_id or without a redirect_uri', () => {
    expect(req('redirect_uri=https%3A%2F%2Fpoker.faithnet.io%2F')).toBeNull();
    expect(req('client_id=pokernight')).toBeNull();
    expect(req('')).toBeNull();
    expect(parseTreasuryRequest('not a url')).toBeNull();
  });
});

describe('refusalFor', () => {
  it('passes a registered client with an exactly-registered redirect_uri', () => {
    const r = req('client_id=pokernight&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F&state=s');
    expect(refusalFor(r, POKER)).toBeNull();
  });

  it('refuses at params when the request could not be parsed', () => {
    expect(refusalFor(null, POKER)?.check).toBe('params');
  });

  it('refuses at client_id when the registry resolved nothing (unknown, disabled, unreachable)', () => {
    const r = req('client_id=ghost-app&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F');
    const refusal = refusalFor(r, null);
    expect(refusal?.check).toBe('client_id');
    expect(refusal?.detail).toContain('ghost-app');
  });

  it('refuses a redirect_uri on a different host', () => {
    const r = req('client_id=pokernight&redirect_uri=https%3A%2F%2Fevil.example%2F');
    expect(refusalFor(r, POKER)?.check).toBe('redirect_uri');
  });

  // CN-1 is exact, and these three are the ways "nearly exact" gets accepted by a looser check.
  it.each([
    ['a path the app added', 'http://localhost:5173/steal'],
    ['the same origin without the registered trailing slash', 'http://localhost:5173'],
    ['a registered URI with a query appended', 'https://poker.faithnet.io/?next=https://evil.example'],
  ])('refuses %s', (_why, uri) => {
    const r = req(`client_id=pokernight&redirect_uri=${encodeURIComponent(uri)}`);
    expect(refusalFor(r, POKER)?.check).toBe('redirect_uri');
  });
});

describe('treasuryReturnUrl', () => {
  it('carries the chosen treasury, how it came to be, and the state', () => {
    const u = new URL(treasuryReturnUrl('https://poker.faithnet.io/', 's1', { treasury: '0xabc', origin: 'chosen' }));
    expect(u.origin + u.pathname).toBe('https://poker.faithnet.io/');
    expect(u.searchParams.get('treasury')).toBe('0xabc');
    expect(u.searchParams.get('treasury_status')).toBe('chosen');
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('distinguishes a treasury that was created from one that was chosen', () => {
    const u = new URL(treasuryReturnUrl('https://poker.faithnet.io/', 's', { treasury: '0xabc', origin: 'created' }));
    expect(u.searchParams.get('treasury_status')).toBe('created');
  });

  it('says denied — and no treasury — when the member declined', () => {
    const u = new URL(treasuryReturnUrl('https://poker.faithnet.io/', 's1', { error: 'denied' }));
    expect(u.searchParams.get('treasury_error')).toBe('denied');
    expect(u.searchParams.get('treasury')).toBeNull();
    expect(u.searchParams.get('state')).toBe('s1');
  });

  it('echoes state UNCHANGED, including query-significant characters and the empty string', () => {
    const state = 'a/b=c&d e+f%20g';
    const u = new URL(treasuryReturnUrl('https://poker.faithnet.io/', state, { treasury: '0x1', origin: 'chosen' }));
    expect(u.searchParams.get('state')).toBe(state);
    const empty = new URL(treasuryReturnUrl('https://poker.faithnet.io/', '', { treasury: '0x1', origin: 'chosen' }));
    expect(empty.searchParams.get('state')).toBe('');
  });

  it('keeps a query the REGISTERED redirect_uri itself carries', () => {
    const u = new URL(treasuryReturnUrl('https://poker.faithnet.io/return?app=poker', 's', { treasury: '0x1', origin: 'chosen' }));
    expect(u.searchParams.get('app')).toBe('poker');
    expect(u.searchParams.get('treasury')).toBe('0x1');
  });
});
