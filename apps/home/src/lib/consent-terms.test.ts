// Spec 445 §4, §5.2 check 9 — what an Allow agreed to, and "asks for nothing more".
import { describe, expect, it } from 'vitest';
import { encodeTimestampTerms } from '@agenticprimitives/delegation';
import { addedLines, consentLinesFor, covers, mintsPaymentAtSignIn, termsDigest, termsFor, wireValidUntil } from './consent-terms';
import type { RelyingApp } from '../whitelabel/schema';

const SITE = '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0' as const;
const ASK = '0xb77a627a4ad23af518f9626186F7bE4D2cC4BFf1' as const;
const app = (over: Partial<RelyingApp> = {}): RelyingApp => ({
  client_id: 'reader', name: 'Reader', redirect_uris: ['https://reader.test/'], allowed_scopes: ['openid', 'profile'],
  allowed_delegation_templates: ['site-login', 'ask-as-me'], delegate: SITE, ask_delegate: ASK, ask_with_login: true,
  read_grant: { resources: ['vault:impact-profile'] }, libraryFolders: ['seed-bible'], ...over,
} as RelyingApp);

describe('termsFor', () => {
  it('reads what a sign-in asks for from the registry', () => {
    const t = termsFor(app(), 'site-login');
    expect(t).toMatchObject({ clientId: 'reader', ask: true, claims: { name: true, email: false }, readGrant: ['vault:impact-profile'], selfVault: null });
    expect(t.delegates).toEqual({ site: SITE.toLowerCase(), ask: ASK.toLowerCase() });
  });
  it('names the ask key as the main wire under ask-as-me', () => {
    expect(termsFor(app(), 'ask-as-me').delegates).toEqual({ site: ASK.toLowerCase() });
  });
});

describe('covers', () => {
  const stored = termsFor(app(), 'site-login');
  it('covers the same ask', () => expect(covers(stored, termsFor(app(), 'site-login'))).toBe(true));
  it('covers an app asking for less', () => {
    expect(covers(stored, termsFor(app({ allowed_scopes: ['openid'], ask_with_login: false, read_grant: undefined, libraryFolders: [] }), 'site-login'))).toBe(true);
  });
  const wider: Array<[string, Partial<RelyingApp>]> = [
    ['a new site key', { delegate: '0x1111111111111111111111111111111111111111' }],
    ['a new ask key', { ask_delegate: '0x2222222222222222222222222222222222222222' }],
    ['the email claim', { idTokenClaims: ['email'] } as Partial<RelyingApp>],
    ['a wider read grant', { read_grant: { resources: ['vault:impact-profile', 'vault:contacts'] } }],
    ['a new library folder', { libraryFolders: ['seed-bible', 'publishing'] }],
    ['a vault grant', { self_vault_grant: { server: 'demo-mcp', resources: ['vault:x'], ops: ['read'] } }],
  ];
  for (const [what, over] of wider) it(`does not cover ${what}`, () => expect(covers(stored, termsFor(app(over), 'site-login'))).toBe(false));
  it('does not cover the name claim, an ask wire, or a wider vault grant, when they were not agreed', () => {
    const none = termsFor(app({ allowed_scopes: ['openid'], ask_with_login: false, self_vault_grant: { server: 'm', resources: ['a'], ops: ['read'] } }), 'site-login');
    expect(covers(none, termsFor(app({ ask_with_login: false, self_vault_grant: { server: 'm', resources: ['a'], ops: ['read'] } }), 'site-login'))).toBe(false);
    expect(covers(none, termsFor(app({ allowed_scopes: ['openid'], self_vault_grant: { server: 'm', resources: ['a'], ops: ['read'] } }), 'site-login'))).toBe(false);
    expect(covers(none, termsFor(app({ allowed_scopes: ['openid'], ask_with_login: false, self_vault_grant: { server: 'm', resources: ['a'], ops: ['read', 'write'] } }), 'site-login'))).toBe(false);
  });
  it('does not carry one template to another, or one client to another', () => {
    expect(covers(stored, termsFor(app(), 'ask-as-me'))).toBe(false);
    expect(covers(stored, termsFor(app({ client_id: 'other' }), 'site-login'))).toBe(false);
  });
});

describe('the digest', () => {
  it('does not depend on field order', () => {
    const t = termsFor(app(), 'site-login');
    const shuffled = Object.fromEntries(Object.entries(t).reverse()) as typeof t;
    expect(termsDigest(shuffled)).toBe(termsDigest(t));
    expect(termsDigest({ ...t, ask: false })).not.toBe(termsDigest(t));
  });
});

describe('the sheet draws from the terms', () => {
  const base = { canDo: ['Know who you are'], cannotDo: ['Move your funds'] };
  it('says each thing the terms add, once', () => {
    const lines = consentLinesFor(base, termsFor(app(), 'site-login'));
    expect(lines.canDo[0]).toBe('Know who you are');
    expect(lines.canDo.join(' ')).toMatch(/name you go by/);
    expect(lines.canDo.join(' ')).toMatch(/Ask your agent/);
    expect(lines.canDo.join(' ')).toMatch(/Read your profile/);
    expect(consentLinesFor(lines, termsFor(app(), 'site-login')).canDo).toEqual(lines.canDo);
  });
  it('marks only what is new', () => {
    const was = termsFor(app({ read_grant: undefined }), 'site-login');
    expect(addedLines(base, was, termsFor(app(), 'site-login'))).toEqual(['Read your profile']);
  });
});

describe('a wire\'s expiry', () => {
  const ENF = '0x00000000000000000000000000000000000000aa';
  it('reads validUntil from the encoder\'s own bytes', () => {
    const wire = { caveats: [{ enforcer: ENF, terms: encodeTimestampTerms(1_700_000_000, 1_800_000_000) }] };
    expect(wireValidUntil(wire, ENF)).toBe(1_800_000_000_000);
  });
  it('is null with no timestamp caveat, and over at once when the terms cannot be read', () => {
    expect(wireValidUntil({ caveats: [] }, ENF)).toBeNull();
    expect(wireValidUntil({ caveats: [{ enforcer: ENF, terms: '0xdead' }] }, ENF)).toBe(0);
  });
});

describe('money', () => {
  it('a client that mints a payment leg at sign-in is never remembered', () => {
    expect(mintsPaymentAtSignIn(app())).toBe(false);
    expect(mintsPaymentAtSignIn(app({ paymentConfig: {} as never }))).toBe(true);
  });
});
