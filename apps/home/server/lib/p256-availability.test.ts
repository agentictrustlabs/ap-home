/**
 * A chain that cannot verify P-256 cannot verify any passkey.
 *
 * `P256Verifier` calls the RIP-7212 precompile at 0x100 and has no fallback — the Daimo one was removed
 * deliberately (audit H7-C.2: a `try fast catch slow` security path with a squattable address, ADR-0013).
 * `staticcall` to an address with NO CODE succeeds with empty returndata, and `verify` requires
 * `out.length >= 32`, so on such a chain every assertion returns false without reverting: it looks
 * exactly like a bad signature.
 *
 * Measured 2026-09-01 with one valid vector — Base Sepolia `0x…01`, faithnet (34348) `0x`. A faithnet
 * account can REGISTER passkeys (authorized by an existing ECDSA custodian, which ecrecover verifies
 * fine) while none of them can ever sign. The sign-in screen offered them anyway and told the member
 * their passkey "is not a custodian of <name>", which is both wrong and unfixable by them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { passkeySigningAvailable } from './p256-availability';

const RPC = (n: number) => `https://rpc.invalid/${n}`; // distinct per test: the probe caches per URL
let seq = 0;
const next = () => RPC(++seq);

function mockRpc(result: unknown) {
  const fn = vi.fn().mockResolvedValue({ json: async () => result } as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe('passkeySigningAvailable', () => {
  it('is true when a valid vector verifies', async () => {
    mockRpc({ result: `0x${'0'.repeat(63)}1` });
    expect(await passkeySigningAvailable(next())).toBe(true);
  });

  it('is FALSE for empty returndata — what an address with no code returns', async () => {
    mockRpc({ result: '0x' });
    expect(await passkeySigningAvailable(next())).toBe(false);
  });

  it('is false when the answer is a 32-byte zero', async () => {
    mockRpc({ result: `0x${'0'.repeat(64)}` });
    expect(await passkeySigningAvailable(next())).toBe(false);
  });

  it('is NULL when the probe cannot be completed — unknown is not unsupported', async () => {
    // A transient RPC failure must never hide a credential method that actually works.
    mockRpc({ error: { code: -32000, message: 'boom' } });
    expect(await passkeySigningAvailable(next())).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await passkeySigningAvailable(next())).toBeNull();
  });

  it('does not cache an unknown answer, so a recovered RPC is picked up', async () => {
    const url = next();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await passkeySigningAvailable(url)).toBeNull();
    mockRpc({ result: `0x${'0'.repeat(63)}1` });
    expect(await passkeySigningAvailable(url)).toBe(true);
  });
});

describe('the sign-in screen', () => {
  it('hides passkey ONLY on a definite false, and says why', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'onboarding', 'EntryExperience.tsx'), 'utf8');
    // `=== false` and not a truthiness check: `undefined`/`null` must keep the button.
    expect(src).toContain("info?.passkeySigningAvailable === false");
    expect(src).toContain('cannot verify passkey signatures yet');
  });
});
