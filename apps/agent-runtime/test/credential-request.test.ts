// Spec 444 W4 — a member asks her organization for a credential: only as a member, only with a device key whose public half
// her vault records, deposited in the organization's vault as one request per member; the steward's issue reads it.
import { describe, it, expect } from 'vitest';
import { credentialRequestInvoker, CREDENTIAL_REQUEST_TOOL } from '../src/credential-request.js';

const ORG = '0x2ce397435e126e513856d27286248f5497108713';
const ME = '0x15200e7140667090106861f42024fa3a6f60230e';
const JWK = { kty: 'EC', crv: 'P-256', x: 'TeqvFpisT4EU99VGJW5pfJ1nlv0bES0546oL_p3g-mM', y: 'lqJJmAsjkN5rpkS1ete67T0vYfPHzV0IeF8Kkmvj-0Y' };
const ctx = { step: { id: 's1' }, index: 0, supplied: [], intent: {} } as never;

function world(o: { member?: boolean; publicJwk?: boolean; unreadable?: boolean } = {}) {
  const writes = new Map<string, unknown>();
  const vault = new Map<string, unknown>([[`credential.device-key:thumb1`, { type: 'ap.device-key.v1', thumbprint: 'thumb1', privateKeyHex: '0xsecret', ...(o.publicJwk === false ? {} : { publicJwk: JWK }) }]]);
  return {
    writes,
    deps: {
      memberRoleAt: async () => (o.unreadable ? null : { membership: o.member === false ? null : { admittedAt: '2026-10-16' } }),
      survey: async () => [...vault.keys()].map((recordType) => ({ recordType })),
      readRecord: async (_s: string, rt: string) => vault.get(rt) ?? null,
      writeRecord: async (s: string, rt: string, r: unknown) => { writes.set(`${s}|${rt}`, r); return { ok: true }; },
    },
  };
}

describe('credential.request', () => {
  it('is the member\'s own act and needs no mandate', () => {
    expect(CREDENTIAL_REQUEST_TOOL.selfAuthorized).toBe(true);
    expect(CREDENTIAL_REQUEST_TOOL.risk).toBe('low');
  });
  it('deposits one request in the ORGANIZATION\'s vault with her public key, never the scalar', async () => {
    const w = world();
    const out = await credentialRequestInvoker(w.deps, ME)('credential.request', { org: ORG }, ctx) as Record<string, any>;
    expect(out.requested).toBe(true);
    const rec = w.writes.get(`${ORG}|credential.request:${ME}`) as Record<string, any>;
    expect(rec).toMatchObject({ type: 'ap.credential-request.v1', member: ME, credentialType: 'membership', deviceKey: JWK, status: 'open' });
    expect(JSON.stringify(rec)).not.toContain('secret');
  });
  it('refuses someone the organization does not record as a member', async () => {
    const out = await credentialRequestInvoker(world({ member: false }).deps, ME)('credential.request', { org: ORG }, ctx) as Record<string, any>;
    expect(out.code).toBe('not_a_member');
  });
  it('says the organization could not be asked rather than calling her a non-member', async () => {
    const out = await credentialRequestInvoker(world({ unreadable: true }).deps, ME)('credential.request', { org: ORG }, ctx) as Record<string, any>;
    expect(out.code).toBe('org_unreadable');
  });
  it('refuses without a device key whose public half is recorded', async () => {
    const out = await credentialRequestInvoker(world({ publicJwk: false }).deps, ME)('credential.request', { org: ORG }, ctx) as Record<string, any>;
    expect(out.code).toBe('no_device_key');
  });

  it('prefers a managed key over a local stand-in, whatever the record order', async () => {
    const w = world();
    const store = (w.deps as unknown as { _store?: Map<string, unknown> });
    void store;
    const vault = new Map<string, unknown>([
      ['credential.device-key:zzz-local', { type: 'ap.device-key.v1', thumbprint: 'zzz-local', privateKeyHex: '0xsecret', publicJwk: JWK, createdAt: '2026-10-17T00:00:00Z' }],
      ['credential.device-key:aaa-managed', { type: 'ap.device-key.v1', thumbprint: 'aaa-managed', managed: { backend: 'akcs', keyId: 'k1', baseUrl: 'https://kms.example', tenantId: 'imb' }, publicJwk: { ...JWK, x: 'managed-x' }, createdAt: '2026-10-16T00:00:00Z' }],
    ]);
    const deps = { ...w.deps, survey: async () => [...vault.keys()].map((recordType) => ({ recordType })), readRecord: async (_s: string, rt: string) => vault.get(rt) ?? null };
    const out = await credentialRequestInvoker(deps, ME)('credential.request', { org: ORG }, ctx) as Record<string, any>;
    expect(out.deviceKeyThumbprint).toBe('aaa-managed');
    expect((w.writes.get(`${ORG}|credential.request:${ME}`) as Record<string, any>).deviceKey.x).toBe('managed-x');
  });
});
