// spec 341 Wave 4 — the Home's A2A fetch transport.
//
// The bigint case is the one that matters. Without it every delivery fails before the network with an
// error that names neither A2A nor delegation, and it is invisible to any test that does not actually
// serialize.

import { describe, it, expect } from 'vitest';
import type { Address } from '@agenticprimitives/types';
import { makeA2aFetchTransport, stringifyA2aRequest } from './a2a-transport';

const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;

function fakeFetch(status = 200, body: unknown = { jsonrpc: '2.0', id: 1, result: { ok: true } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('bigint salt survives serialization', () => {
  it('encodes a bigint as a decimal string', () => {
    const out = stringifyA2aRequest({ params: { delegation: { salt: 12345678901234567890n } } });
    expect(out).toContain('"12345678901234567890"');
  });

  // The regression this exists for: plain JSON.stringify THROWS here.
  it('does not throw on the shape a real delegation has', () => {
    expect(() => stringifyA2aRequest({ delegation: { salt: 1n, caveats: [], signature: '0x' } })).not.toThrow();
    expect(() => JSON.stringify({ salt: 1n })).toThrow(/BigInt/);
  });

  it('leaves everything else alone', () => {
    const out = JSON.parse(stringifyA2aRequest({ a: 1, b: 'x', c: [true, null] }));
    expect(out).toEqual({ a: 1, b: 'x', c: [true, null] });
  });
});

describe('it posts where the resolver says, and nowhere else', () => {
  it('posts JSON-RPC to the resolved origin', async () => {
    const f = fakeFetch();
    const t = makeA2aFetchTransport({
      resolveAgentOrigin: async () => 'https://bob.example.io',
      fetchImpl: f.impl,
    });
    await t.rpc(BOB, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    expect(f.calls[0]!.url).toBe('https://bob.example.io/api/a2a');
    expect(f.calls[0]!.init.method).toBe('POST');
  });

  it('tolerates a trailing slash on the origin', async () => {
    const f = fakeFetch();
    const t = makeA2aFetchTransport({ resolveAgentOrigin: async () => 'https://bob.example.io/', fetchImpl: f.impl });
    await t.rpc(BOB, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    expect(f.calls[0]!.url).toBe('https://bob.example.io/api/a2a');
  });

  // Guessing an origin would send a signed grant and a signed message to whoever answers there.
  it('refuses to guess when the agent does not resolve', async () => {
    const f = fakeFetch();
    const t = makeA2aFetchTransport({ resolveAgentOrigin: async () => null, fetchImpl: f.impl });
    await expect(t.rpc(BOB, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} })).rejects.toThrow(
      /cannot resolve an A2A endpoint/,
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe('transport failure is not agent refusal', () => {
  // "The host is down" and "the agent refused you" call for opposite responses — retry versus do not.
  // Collapsing them into one error is how a retry loop hammers an agent that already said no.
  it('throws on a non-2xx rather than returning it as a result', async () => {
    const f = fakeFetch(502, {});
    const t = makeA2aFetchTransport({ resolveAgentOrigin: async () => 'https://bob.example.io', fetchImpl: f.impl });
    await expect(t.rpc(BOB, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} })).rejects.toThrow(
      /a2a transport 502/,
    );
  });

  it('returns a JSON-RPC error RESULT untouched — that is the agent speaking', async () => {
    const f = fakeFetch(200, { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unauthorized' } });
    const t = makeA2aFetchTransport({ resolveAgentOrigin: async () => 'https://bob.example.io', fetchImpl: f.impl });
    const res = await t.rpc(BOB, { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} });
    expect((res as { error: { message: string } }).error.message).toBe('unauthorized');
  });
});
