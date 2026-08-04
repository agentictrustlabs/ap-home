// spec 341 §7 — the in-Worker marker, split off the custody secret.
//
// The property under test is a NEGATIVE one and it is the whole reason the split happened: a party
// holding `A2A_CUSTODY_BRIDGE_SECRET` must no longer be able to open `internal.*`. Before the split
// they were the same value, so a leak of the Home↔demo-a2a custody secret also conferred
// `internal.deliver` / `internal.dm.body.put` / `internal.channels.post` against ANY principal,
// bypassing every owner gate.

import { describe, it, expect } from 'vitest';
import { internalMarker, isInternalCall, internalHeaders } from '../src/internal-marker.js';

const req = (v?: string) => ({ headers: { get: (n: string) => (n === 'x-ap-internal' && v !== undefined ? v : null) } });
const MARKER = '0xdeadbeefdeadbeefdeadbeefdeadbeef';

describe('the custody secret no longer opens internal ops', () => {
  it('REFUSES the old custody secret when it is not the marker', () => {
    // The exact regression the split exists to prevent.
    const env = { A2A_INTERNAL_MARKER: MARKER, A2A_CUSTODY_BRIDGE_SECRET: 'the-custody-secret' } as never;
    expect(isInternalCall(req('the-custody-secret'), env)).toBe(false);
  });

  it('accepts the marker', () => {
    expect(isInternalCall(req(MARKER), { A2A_INTERNAL_MARKER: MARKER })).toBe(true);
  });
});

describe('unprovisioned is refused, never permitted', () => {
  it('refuses every caller when the marker is unset', () => {
    // "No marker configured therefore allow" is the fail-open shape; NEW-H2 is the same bug in a
    // membership check. Absence denies.
    for (const env of [{}, { A2A_INTERNAL_MARKER: undefined }] as never[]) {
      expect(isInternalCall(req('anything'), env)).toBe(false);
      expect(isInternalCall(req(''), env)).toBe(false);
    }
  });

  it('treats an EMPTY STRING as unset', () => {
    // `wrangler` binds `VAR = ""` as an empty string rather than leaving it undefined, and `??` returns
    // it happily — which would compare '' === '' and admit every caller. That shape has bitten this
    // repo before, which is why it is asserted rather than assumed.
    const env = { A2A_INTERNAL_MARKER: '' };
    expect(internalMarker(env)).toBeNull();
    expect(isInternalCall(req(''), env)).toBe(false);
  });

  it('THROWS on an outbound call rather than sending an unmarked one', () => {
    // A silently-unmarked request would be refused at the far end and surface as an unrelated
    // downstream failure, far from the missing variable that caused it.
    expect(() => internalHeaders({})).toThrow(/A2A_INTERNAL_MARKER/);
  });
});

describe('the header itself', () => {
  it('carries the marker and a JSON content type', () => {
    expect(internalHeaders({ A2A_INTERNAL_MARKER: MARKER })).toMatchObject({
      'content-type': 'application/json',
      'x-ap-internal': MARKER,
    });
  });

  it('lets a caller add headers without dropping the marker', () => {
    const h = internalHeaders({ A2A_INTERNAL_MARKER: MARKER }, { 'x-extra': '1' });
    expect(h['x-ap-internal']).toBe(MARKER);
    expect(h['x-extra']).toBe('1');
  });

  it('refuses a near-miss', () => {
    const env = { A2A_INTERNAL_MARKER: MARKER };
    expect(isInternalCall(req(MARKER.slice(0, -1)), env)).toBe(false);
    expect(isInternalCall(req(`${MARKER} `), env)).toBe(false);
    expect(isInternalCall(req(MARKER.toUpperCase()), env)).toBe(false);
  });
});
