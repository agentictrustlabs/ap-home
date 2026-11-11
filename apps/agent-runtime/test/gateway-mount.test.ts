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
import { buildMountedGatewayDeps, mountedAuthenticator, unreachableWrapper } from '../src/gateway-mount.js';

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

// Spec 445 §3.4 (fabric audit DATA-3) — the gateway's ingress takes its caller from an injected authenticator
// and nowhere else. No ingress op is mounted today (the one mounted op is a verdict-keyed read), so the port is
// absent and every ingress is refused; this is the implementation an ingress op must inject when it climbs.
describe('the mounted authenticator hands over what InteractionsDO admitted, and nothing from the request', () => {
  const PRINCIPAL = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
  const ACTOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const req = (body: unknown = {}) => new Request('https://do/x', { method: 'POST', body: JSON.stringify(body), headers: { 'x-principal': '0xcccccccccccccccccccccccccccccccccccccccc' } });

  it('names this object as the principal, the admitted session as the actor, the op\'s tier', async () => {
    const auth = mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => ({ actor: ACTOR, tier: 'communication' }) });
    expect(await auth(req())).toEqual({ principal: `eip155:84532:${PRINCIPAL.toLowerCase()}`, actor: `eip155:84532:${ACTOR}`, tier: 'communication' });
  });

  it('ignores every identity the request itself carries', async () => {
    const auth = mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => ({ actor: ACTOR, tier: 'execution-fast' }) });
    const got = await auth(req({ principal: '0xdddddddddddddddddddddddddddddddddddddddd', actor: '0xdddddddddddddddddddddddddddddddddddddddd', tier: 'execution-orchestrated' }));
    expect(got).toEqual({ principal: `eip155:84532:${PRINCIPAL.toLowerCase()}`, actor: `eip155:84532:${ACTOR}`, tier: 'execution-fast' });
  });

  it('refuses when the request was not admitted, and reads the admission at call time', async () => {
    let admitted: { actor: string; tier: 'communication' } | null = null;
    const auth = mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => admitted });
    expect(await auth(req())).toBeNull();
    admitted = { actor: ACTOR, tier: 'communication' };
    expect(await auth(req())).not.toBeNull();
    admitted = null;
    expect(await auth(req())).toBeNull();
  });

  it('refuses a malformed actor, principal, tier or chain rather than guessing', async () => {
    const ok = { actor: ACTOR, tier: 'communication' as const };
    expect(await mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => ({ ...ok, actor: 'alice.me' }) })(req())).toBeNull();
    expect(await mountedAuthenticator({ chainId: 84532, principal: 'calvary.org', admitted: () => ok })(req())).toBeNull();
    expect(await mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => ({ ...ok, tier: 'admin' as never }) })(req())).toBeNull();
    expect(await mountedAuthenticator({ chainId: 0, principal: PRINCIPAL, admitted: () => ok })(req())).toBeNull();
  });

  it('is absent from the mount unless an op supplies it — the gateway then refuses every ingress', () => {
    expect(buildMountedGatewayDeps({ vault: fakeVault(), verify: async () => VERDICT }).authenticate).toBeUndefined();
    const authenticate = mountedAuthenticator({ chainId: 84532, principal: PRINCIPAL, admitted: () => null });
    expect(buildMountedGatewayDeps({ vault: fakeVault(), verify: async () => VERDICT, authenticate }).authenticate).toBe(authenticate);
  });
});
