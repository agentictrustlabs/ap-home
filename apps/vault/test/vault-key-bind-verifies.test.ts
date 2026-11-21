// The vault-key bind: the owner's signature is checked on chain at bind time, and only the signed terms are stored.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVaultKeyUseCaveat } from '@agenticprimitives/delegation';
import { verifyAndStoreBinding, type VaultKeyEnv } from '../src/vault-key';

const OWNER = '0x6239a50bf724eae48e2d86af5df21ba294c27330';
const grant = { vaultId: 'vault-1', kmsKeyRef: 'kek-1', resources: ['vault:profile', 'vault:notes'], classificationCeiling: 'confidential', ops: ['read', 'write'], noSubdelegation: true };
const authorization = () => ({
  delegator: OWNER, delegate: '0x0000000000000000000000000000000000000abc', authority: '0x' + '00'.repeat(32),
  caveats: [buildVaultKeyUseCaveat(grant)], salt: 12345n, signature: '0xc0ffee',
}) as never;
const input = (over: Record<string, unknown> = {}) => ({
  owner: OWNER, vaultId: 'vault-1', kmsKeyRef: 'kek-1', allowedResources: ['vault:profile'], classificationCeiling: 'confidential',
  ops: ['read'] as ('read' | 'write')[], expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), authorization: authorization(), ...over,
});

function world(chainSays: boolean) {
  const puts: unknown[] = [];
  let chainCalls = 0;
  const DB = { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => { puts.push(a); return { success: true }; }, first: async () => null, all: async () => ({ results: [] }) }) }) };
  vi.stubGlobal('fetch', async (_u: unknown, init?: { body?: string }) => {
    const req = JSON.parse(init?.body ?? '{}');
    const one = (r: { id: number; method: string }) => {
      if (r.method === 'eth_call') chainCalls++;
      return { jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? '0x6e1f' : '0x' + (chainSays ? '1' : '0').padStart(64, '0') };
    };
    return new Response(JSON.stringify(Array.isArray(req) ? req.map(one) : one(req)), { headers: { 'content-type': 'application/json' } });
  });
  const env = { DB, RPC_URL: 'https://rpc.example.test', CHAIN_ID: '28191', DELEGATION_MANAGER: '0x' + '11'.repeat(20), UNIVERSAL_SIGNATURE_VALIDATOR: '0x' + '22'.repeat(20), VAULT_SERVER_ID: 'home-vault-test' } as unknown as VaultKeyEnv;
  return { env, puts, calls: () => chainCalls };
}

afterEach(() => vi.unstubAllGlobals());

describe('vault-key bind verifies the signature on chain', () => {
  it('REFUSES an authorization the chain says the owner did not sign, and stores nothing', async () => {
    const w = world(false);
    const r = await verifyAndStoreBinding(w.env, input());
    expect(r.ok).toBe(false);
    expect(w.calls()).toBeGreaterThan(0); // the on-chain check actually ran
    expect(w.puts).toHaveLength(0);
  });

  it('stores the binding when the chain confirms the signature', async () => {
    const w = world(true);
    const r = await verifyAndStoreBinding(w.env, input());
    expect(r).toEqual({ ok: true });
    expect(w.calls()).toBeGreaterThan(0);
    expect(w.puts).toHaveLength(1);
  });

  it('fails closed with no validator configured', async () => {
    const w = world(true);
    (w.env as { UNIVERSAL_SIGNATURE_VALIDATOR?: string }).UNIVERSAL_SIGNATURE_VALIDATOR = '';
    await expect(verifyAndStoreBinding(w.env, input()).then((r) => r.ok, () => false)).resolves.toBe(false);
    expect(w.puts).toHaveLength(0);
  });

  it('REFUSES a body that asks for more than was signed — before any chain call', async () => {
    for (const over of [
      { allowedResources: ['vault:profile', 'vault:everything'] }, { ops: ['read', 'write', 'read'].slice(0, 2), authorization: { ...authorization(), caveats: [buildVaultKeyUseCaveat({ ...grant, ops: ['read'] })] } },
      { kmsKeyRef: 'someone-elses-kek' }, { vaultId: 'vault-2' }, { classificationCeiling: 'restricted' },
      { expiresAt: new Date(Date.now() - 1000).toISOString() }, { expiresAt: new Date(Date.now() + 3650 * 86_400_000).toISOString() }, { expiresAt: 'never' },
    ]) {
      const w = world(true);
      const r = await verifyAndStoreBinding(w.env, input(over));
      expect(r.ok, JSON.stringify(Object.keys(over))).toBe(false);
      expect(w.calls()).toBe(0);
      expect(w.puts).toHaveLength(0);
    }
  });
});
