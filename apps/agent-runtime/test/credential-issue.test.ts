// Spec 444 W3 — the organization issues its member's credential: refuses a non-member, refuses an organization with no
// issuer facet, asks for a vouched claim it was not given, signs under issuance evidence naming THIS digest, records the
// issuance in the organization's vault without the claim values, and delivers the credential to the member.
import { describe, it, expect } from 'vitest';
import { InputRequired } from '@agenticprimitives/orchestration';
import { LocalEs256Signer, verifyEs256, p256JwkThumbprint } from '@agenticprimitives/key-custody';
import { credentialDigestOf } from '@agenticprimitives/estate-projection';
import { credentialIssueInvoker, CREDENTIAL_ISSUE_TOOL, type IssuerFacetRecordV1 } from '../src/credential-issue.js';

const ORG = '0x2ce397435e126e513856d27286248f5497108713';
const MEMBER = '0x15200e7140667090106861f42024fa3a6f60230e';
const STRANGER = '0x9999999999999999999999999999999999999999';
const STEWARD = '0x3f96a0b26c59260b4fe74b40726b000b12ef33d3';
const ctx = { step: { id: 's1' }, index: 0, supplied: [], intent: {} } as never;
const sha256Hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

function world(opts: { facet?: IssuerFacetRecordV1 | null; members?: string[]; writeFails?: boolean } = {}) {
  const issuingKey = LocalEs256Signer.generate();
  const device = LocalEs256Signer.generate().publicJwk();
  const facet: IssuerFacetRecordV1 | null = opts.facet === undefined
    ? { type: 'ap.issuer-facet.v1', keyId: 'issuer-key:sd-jwt:imbnet-org-1', akcsKeyId: 'akcs-key-1', credentialType: 'membership', claimSchema: ['age', 'member'], vcSize: '1k', issuer: `eip155:34349:${ORG}` }
    : opts.facet;
  const records = new Map<string, unknown>();
  for (const m of opts.members ?? [MEMBER]) records.set(`org.membership:member:${m}`, { member: m });
  if (facet) records.set(`credential.issuer-facet:${facet.keyId}`, facet);
  const evidence: Array<{ subject: string; claims: Record<string, string> }> = [];
  const signed: Array<{ keyId: string; message: Uint8Array; ev: { evidenceToken: string; audience: string } }> = [];
  const deps = {
    readRecord: async (_s: string, rt: string) => records.get(rt) ?? null,
    survey: async () => [...records.keys()].map((recordType) => ({ recordType })),
    writeRecord: async (_s: string, rt: string, r: unknown) => { if (opts.writeFails) return { ok: false, error: 'record_scope_denied' }; records.set(rt, r); return { ok: true }; },
    issuingSign: async (keyId: string, message: Uint8Array, ev: { evidenceToken: string; audience: string }) => { signed.push({ keyId, message, ev }); return issuingKey.sign(message); },
    mintIssuanceEvidence: async (subject: string, claims: { digest: string; issuer_key_id: string; credential_type: string }) => { evidence.push({ subject, claims }); return `ev.${claims.digest}`; },
    credentialDigestOf: async (jwt: string) => credentialDigestOf(jwt),
    thumbprintOf: (jwk: { x: string; y: string }) => p256JwkThumbprint(jwk),
    sha256Hex,
  };
  return { deps, records, evidence, signed, issuingKey, device };
}

describe('credential.issue', () => {
  it('is the organization\'s act under its mandate: high risk, resource and authority are the organization', () => {
    expect(CREDENTIAL_ISSUE_TOOL.risk).toBe('high');
    expect(CREDENTIAL_ISSUE_TOOL.capability).toMatchObject({ resourceArg: 'org', authorityArg: 'org' });
  });

  it('issues to a member: evidence names the digest signed, the issuance is recorded without claims, the credential is delivered', async () => {
    const w = world();
    const out = await credentialIssueInvoker(w.deps, ORG, STEWARD)('credential.issue', { org: ORG, member: MEMBER, deviceKey: w.device, claims: { age: '0000021' } }, ctx) as Record<string, any>;
    expect(out.issued).toBe(true);
    expect(w.signed).toHaveLength(1);
    expect(w.signed[0]!.keyId).toBe('akcs-key-1');
    expect(w.evidence[0]!.claims).toEqual({ digest: `0x${await sha256Hex(w.signed[0]!.message)}`, issuer_key_id: 'issuer-key:sd-jwt:imbnet-org-1', credential_type: 'membership' });
    expect(w.signed[0]!.ev.evidenceToken).toBe(`ev.${w.evidence[0]!.claims.digest}`);
    const rec = w.records.get(`credential.issued:${out.digest}`) as Record<string, unknown>;
    expect(rec).toMatchObject({ type: 'ap.issuance.v1', issuedTo: MEMBER, credentialType: 'membership', deviceKeyThumbprint: p256JwkThumbprint(w.device), by: STEWARD });
    expect(JSON.stringify(rec)).not.toContain('0000021');
    expect(out.digest).toBe(credentialDigestOf(out.credential.jwt));
    // The signature is the issuing key's over the JWS signing input.
    const [h, p, s] = String(out.credential.jwt).split('~')[0]!.split('.');
    const sig = Uint8Array.from(atob(s!.replace(/-/g, '+').replace(/_/g, '/').padEnd(s!.length + ((4 - (s!.length % 4)) % 4), '=')), (c) => c.charCodeAt(0));
    expect(verifyEs256(w.issuingKey.publicJwk(), new TextEncoder().encode(`${h}.${p}`), sig)).toBe(true);
    expect(out.credential.disclosures.length).toBeGreaterThanOrEqual(2);
  });

  it('never issues to someone the organization does not record as a member', async () => {
    const w = world();
    const out = await credentialIssueInvoker(w.deps, ORG, STEWARD)('credential.issue', { org: ORG, member: STRANGER, deviceKey: w.device, claims: { age: '0000021' } }, ctx) as Record<string, any>;
    expect(out.code).toBe('not_a_member');
    expect(w.signed).toHaveLength(0);
  });

  it('refuses an organization with no issuer facet', async () => {
    const w = world({ facet: null });
    const out = await credentialIssueInvoker(w.deps, ORG, STEWARD)('credential.issue', { org: ORG, member: MEMBER, deviceKey: w.device }, ctx) as Record<string, any>;
    expect(out.code).toBe('no_issuer_facet');
  });

  it('asks for a vouched claim rather than inventing it', async () => {
    const w = world();
    await expect(credentialIssueInvoker(w.deps, ORG, STEWARD)('credential.issue', { org: ORG, member: MEMBER, deviceKey: w.device }, ctx)).rejects.toBeInstanceOf(InputRequired);
    expect(w.signed).toHaveLength(0);
  });

  it('is issued only by the mandate\'s delegator', async () => {
    const w = world();
    await expect(credentialIssueInvoker(w.deps, STRANGER, STEWARD)('credential.issue', { org: ORG, member: MEMBER, deviceKey: w.device, claims: { age: '0000021' } }, ctx)).rejects.toThrow(/delegator/);
  });

  it('does not deliver a credential the organization could not record', async () => {
    const w = world({ writeFails: true });
    const out = await credentialIssueInvoker(w.deps, ORG, STEWARD)('credential.issue', { org: ORG, member: MEMBER, deviceKey: w.device, claims: { age: '0000021' } }, ctx) as Record<string, any>;
    expect(out.code).toBe('record_failed');
    expect(out.credential).toBeUndefined();
  });
});
