/**
 * Never mint a passkey a chain cannot verify.
 *
 * A chain without the P-256 precompile still ACCEPTS a passkey registration — adding one is authorized
 * by an existing ECDSA custodian, and ecrecover works fine. So the member ends up holding a credential
 * that exists on their device, is registered on chain, and can never sign; the OS keeps offering it,
 * and every attempt reports "that passkey is not a custodian". Faithnet ran that way until 2026-09-01.
 *
 * The guard belongs at creation, not at sign-in: by sign-in the useless credential already exists.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function withRpc(reply: unknown | Error) {
  vi.resetModules();
  vi.stubGlobal('fetch', reply instanceof Error
    ? vi.fn().mockRejectedValue(reply)
    : vi.fn().mockResolvedValue({ json: async () => reply } as unknown as Response));
  return import('./p256-support');
}

describe('passkeysVerifiableOnChain', () => {
  it('is true when the precompile verifies a valid vector', async () => {
    const m = await withRpc({ result: `0x${'0'.repeat(63)}1` });
    expect(await m.passkeysVerifiableOnChain()).toBe(true);
  });

  it('is FALSE on empty returndata — what an address with no code returns', async () => {
    const m = await withRpc({ result: '0x' });
    expect(await m.passkeysVerifiableOnChain()).toBe(false);
  });

  it('is NULL when the probe cannot be completed', async () => {
    const m = await withRpc(new Error('offline'));
    expect(await m.passkeysVerifiableOnChain()).toBeNull();
  });
});

describe('assertPasskeysVerifiable', () => {
  it('throws only on a definite false', async () => {
    const m = await withRpc({ result: '0x' });
    await expect(m.assertPasskeysVerifiable()).rejects.toThrow(/cannot verify passkey signatures/i);
  });

  it('FAILS OPEN when the answer is unknown — a timed-out probe must not block a working credential', async () => {
    const m = await withRpc(new Error('offline'));
    await expect(m.assertPasskeysVerifiable()).resolves.toBeUndefined();
  });

  it('allows creation on a chain that verifies', async () => {
    const m = await withRpc({ result: `0x${'0'.repeat(63)}1` });
    await expect(m.assertPasskeysVerifiable()).resolves.toBeUndefined();
  });
});

describe('the guard sits at the one place credentials are minted', () => {
  const SRC = readFileSync(join(__dirname, 'passkey.ts'), 'utf8');

  it('registerPasskey checks before calling navigator.credentials.create', () => {
    // Anchor the end search FROM the function start: the file header also mentions
    // navigator.credentials.create, and slicing to that gave an empty string that passed nothing.
    const start = SRC.indexOf('export async function registerPasskey');
    expect(start).toBeGreaterThan(-1);
    const fn = SRC.slice(start, SRC.indexOf('navigator.credentials.create(', start));
    expect(fn).toContain('await assertPasskeysVerifiable();');
  });

  it('and there is no second creation path that bypasses it', () => {
    // Every mint must go through registerPasskey, or the guard is decorative.
    const creates = [...SRC.matchAll(/navigator\.credentials\.create\(/g)];
    expect(creates.length).toBe(1);
  });
});

describe('a negative answer expires, a positive one does not', () => {
  it('re-probes after a false — a chain can GAIN the precompile', async () => {
    // Faithnet gained it mid-session (2026-09-01) and the cached `false` kept the Home refusing to
    // create passkeys that would by then have worked. A stale negative is the answer most likely to
    // become wrong, and the most costly when it does.
    vi.resetModules();
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ result: '0x' }) } as unknown as Response)
      .mockResolvedValueOnce({ json: async () => ({ result: `0x${'0'.repeat(63)}1` }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const m = await import('./p256-support');
    expect(await m.passkeysVerifiableOnChain()).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(await m.passkeysVerifiableOnChain()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not re-probe after a true — a chain does not lose one', async () => {
    vi.resetModules();
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ result: `0x${'0'.repeat(63)}1` }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const m = await import('./p256-support');
    expect(await m.passkeysVerifiableOnChain()).toBe(true);
    expect(await m.passkeysVerifiableOnChain()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
