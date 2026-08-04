// The MOUNT's wiring (ADR-0055 amendment) — that `PrincipalGatewayDO`, as demo-a2a constructs it,
// reaches the owner's MCP vault and not its own DO-SQL one.
//
// DIVISION OF LABOUR, SO NEITHER SIDE ASSUMES THE OTHER DID IT. That the gateway HONOURS an injected
// vault on a real code path is proven in `packages/fabric` (`cloudflare-principal-gateway-do.test.ts`),
// where the SQL fake needed to drive the DO already lives. What is proven HERE is that this app hands it
// one — a distinction worth keeping, because "injectable" and "injected" fail in different places and a
// deployment that skipped the second would look exactly like one that never had the first.

import { describe, it, expect } from 'vitest';
import type { Vault } from '@agenticprimitives/vault';
import { buildMountedGatewayDeps, unreachableWrapper } from '../src/gateway-mount.js';

const VERDICT = {
  principal: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sessionKey: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  delegationHash: '0xdead',
  epoch: '84532:0xmanager',
  manager: '0xmanager',
};

const fakeVault = (): Vault =>
  ({
    async read() { return { data: { marker: 'from-the-mcp-vault' } }; },
    async write() { /* unused */ },
    async list() { return []; },
  }) as unknown as Vault;

describe('the mounted gateway reads the owner’s vault, not its own', () => {
  it('hands the gateway the injected vault', async () => {
    const v = fakeVault();
    const deps = buildMountedGatewayDeps({ vault: v, verify: async () => VERDICT });
    // The identity, not merely "a vault": the gateway constructs a DO-SQL vault when this seam is absent,
    // and that one would also satisfy any structural assertion while storing person records DO-local.
    expect(deps.vault?.(unreachableWrapper())).toBe(v);
  });

  it('refuses the KEK wrapper rather than producing one', async () => {
    // `wrapperFor` is only reachable if the injected vault stopped diverting — i.e. if the gateway is
    // about to write DO-local. It must fail loudly there. A wrapper that returned a plausible key would
    // let a custody change happen with no symptom, which is the failure this whole step exists to avoid.
    const deps = buildMountedGatewayDeps({ vault: fakeVault(), verify: async () => VERDICT });
    const wrapper = await deps.wrapperFor('0xaaa');
    // Synchronously, not as a rejected promise — see `unreachableWrapper`. Asserting the SHAPE of the
    // failure and not only that it fails: a `rejects` assertion would still pass if this were softened
    // into a promise an unrelated `.catch()` could absorb, which is the softening worth preventing.
    expect(() => wrapper.generateSessionDataKey({ aadContext: {} })).toThrow(/ADR-0055|DO-SQL vault/);
    expect(() =>
      wrapper.decryptSessionDataKey({ encryptedDataKey: new Uint8Array(), aadContext: {}, keyId: 'k', keyVersion: '1' }),
    ).toThrow(/ADR-0055|DO-SQL vault/);
  });
});

describe('the cold path is a refusal, never an assumption', () => {
  it('passes a null verification through as no verdict', async () => {
    const deps = buildMountedGatewayDeps({ vault: fakeVault(), verify: async () => null });
    // `invokeFast` treats a missing verdict as "cold path required" and refuses. Anything other than
    // `null` here — an empty object, a verdict with blank fields — would be cached and reused warm.
    expect(await deps.verifyToken('anything')).toBeNull();
  });

  it('stamps the verdict with when it was verified', async () => {
    const deps = buildMountedGatewayDeps({
      vault: fakeVault(),
      verify: async () => VERDICT,
      now: () => '2026-08-04T00:00:00.000Z',
    });
    const v = await deps.verifyToken('t');
    expect(v).toMatchObject({ ...VERDICT, verifiedAt: '2026-08-04T00:00:00.000Z' });
  });
});

describe('the mounted op mirrors the one it replaces', () => {
  it('claims exactly the record scope `inbox.get` claims', async () => {
    // A migration step that quietly needed a WIDER scope than the op it mirrors would not be a migration
    // step. Read from the module so this breaks if either entry moves — restating both literals here
    // would pass forever while the real table drifted.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/interactions-do.ts', import.meta.url), 'utf8'),
    );
    const scope = (op: string): string | undefined =>
      new RegExp(`'${op.replace('.', '\\.')}':\\s*'([^']+)'`).exec(src)?.[1];
    expect(scope('gateway.inbox.get')).toBe(scope('inbox.get'));
    expect(scope('gateway.inbox.get')).toBe('vault:inbox.data');
  });
});
