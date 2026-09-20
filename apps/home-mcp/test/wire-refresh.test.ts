// Spec 410 §1.2 step 4 — the wire refresh: after a credential rotation at her Home, this Worker's stale ask-as-me
// wire is exchanged for the re-issued one, signed DIRECTLY by this Worker's key (never wrapped in the wire in
// question), and the answer is read as current / superseded / gone.
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAddress, type Hex } from 'viem';
import { parseSessionAuthorization, callerAssertionDigest, requestBodyHash } from '@agenticprimitives/a2a/standard';
import { parseSessionWrappedSignature } from '@agenticprimitives/a2a';
import { hashDelegation, ROOT_AUTHORITY } from '@agenticprimitives/delegation';
import { refreshWire, type PersonIdentity } from '../src/a2a.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const delegate = privateKeyToAccount(KEY).address;
const PERSON = '0x0a60000000000000000000000000000000000001' as const;
const DM = '0x0000000000000000000000000000000000000010' as const;
const wire = { delegator: PERSON, delegate, authority: ROOT_AUTHORITY, caveats: [], salt: '7', signature: `0x${'ab'.repeat(65)}` as Hex };
const id: PersonIdentity = { agent: PERSON, privateKey: KEY, wire };
const chain = { chainId: 34348, delegationManager: DM };

function fetchAnswering(status: number, body: unknown, capture: { req?: { url: string; init: RequestInit } }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.req = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('refreshWire', () => {
  it('asks the a2a origin with a DIRECT assertion by this key over the exact body, naming the wire by hash', async () => {
    const cap: { req?: { url: string; init: RequestInit } } = {};
    const out = await refreshWire(id, 'https://a2a.example', chain, fetchAnswering(200, { ok: true, status: 'current', hash: 'x', wire: null }, cap));
    expect(out).toEqual({ status: 'current' });
    expect(cap.req?.url).toBe('https://a2a.example/wires/refresh');
    const raw = String(cap.req?.init.body);
    const body = JSON.parse(raw) as { method: string; delegator: string; hash: string };
    expect(body.method).toBe('wires/refresh');
    expect(body.delegator).toBe(PERSON.toLowerCase());
    expect(body.hash).toBe(hashDelegation({ ...wire, salt: 7n, caveats: [] }, chain.chainId, DM));
    const a = parseSessionAuthorization((cap.req?.init.headers as Record<string, string>).authorization);
    expect(a?.agent).toBe(delegate.toLowerCase());
    expect(a?.method).toBe('wires/refresh');
    expect(a?.bodyHash).toBe(requestBodyHash(raw));
    expect(a?.audience).toBe('https://a2a.example');
    // Direct, not wire-wrapped: the wire is what is being refreshed.
    expect(parseSessionWrappedSignature(a!.signature)).toBeNull();
    const { signature, ...base } = a!;
    expect((await recoverAddress({ hash: callerAssertionDigest(base), signature: signature as Hex })).toLowerCase()).toBe(delegate.toLowerCase());
  });
  it('superseded → the wire to hold now', async () => {
    const next = { ...wire, signature: '0x03' as Hex };
    const out = await refreshWire(id, 'https://a2a.example', chain, fetchAnswering(200, { ok: true, status: 'superseded', hash: '0xabc', wire: next }, {}));
    expect(out).toEqual({ status: 'superseded', wire: next, hash: '0xabc' });
  });
  it('410 → gone (struck at the Home: a revocation, re-authorize there)', async () => {
    expect(await refreshWire(id, 'https://a2a.example', chain, fetchAnswering(410, { ok: false, status: 'gone' }, {}))).toEqual({ status: 'gone' });
  });
  it('anything else → unavailable, with the reason; the refusal that prompted the refresh stands', async () => {
    const out = await refreshWire(id, 'https://a2a.example', chain, fetchAnswering(503, { ok: false, error: 'the wire gate is not configured' }, {}));
    expect(out.status).toBe('unavailable');
    if (out.status === 'unavailable') expect(out.error).toMatch(/not configured/);
  });
});
