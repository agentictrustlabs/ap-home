// Slice S2 — THE LIBRARY READ BY ANOTHER AGENT, UNDER A GRANT ITS OWNER SIGNED. A restricted work's text page and parts
// are saved PRIVATE in the publisher agent's Library; an Ask workspace (a separate smart agent) reads them only under a
// delegation FROM the publisher agent TO the workspace. These tests sign real delegations with test keys (EIP-712 digest
// under `hashDelegation`, ECDSA recovered in place of the ERC-1271 read) and drive every leg of the admission, plus the
// owner's own read paging that a re-hash of a whole document needs.
import { describe, expect, it } from 'vitest';
import { recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  buildMethodAuthorityCaveats, buildVaultRecordScopeCaveat, buildCaveat, encodeTimestampTerms, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms,
  hashDelegation, methodSelector, VAULT_RECORD_SCOPE_ENFORCER, type Caveat, type Delegation, type EnforcerAddressMap,
} from '@agenticprimitives/delegation';
import { A2A_ANY_SKILL } from '@agenticprimitives/a2a';
import {
  libraryInvoker, grantedLibraryRead, makeLibraryGrantedReadSkill, libraryEntryScope, libraryFolderScope,
  LIBRARY_GRANTED_READ, LIBRARY_TEXT_MAX_CHARS, type LibraryEntry, type LibraryGrantChecks, type LibraryToolDeps,
} from '../src/library-tools.js';

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const OTHER_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const OWNER = privateKeyToAccount(OWNER_PK).address.toLowerCase() as Address; // the publisher agent (stands in for its SA)
const OTHER = privateKeyToAccount(OTHER_PK).address.toLowerCase() as Address; // some other agent
const WORKSPACE = ('0x' + 'a1'.repeat(20)) as Address;                          // the Ask workspace .svc agent
const STRANGER = ('0x' + 'b2'.repeat(20)) as Address;
const CHAIN = 34348;
const DM = ('0x' + 'd0'.repeat(20)) as Address;
const VAULT = 'demo-mcp';
const E: EnforcerAddressMap = {
  delegationManager: DM,
  timestamp: ('0x' + '11'.repeat(20)) as Address,
  value: ('0x' + '12'.repeat(20)) as Address,
  allowedTargets: ('0x' + '13'.repeat(20)) as Address,
  allowedMethods: ('0x' + '14'.repeat(20)) as Address,
};
const NOW = 1_800_000_000;

// The Library: a long restricted text page, its parts, a document outside any grant, and a folder-scoped one.
const LONG = 'In the beginning '.repeat(1500); // 25,500 chars — three pages
const enc = (t: string) => btoa(unescape(encodeURIComponent(t)));
const catalog: LibraryEntry[] = [
  { id: 'art-restricted', kind: 'md', name: 'work.md', folder: 'works/restricted', accessPolicy: 'private', version: 1, releases: [{ canonicalId: '0xc', version: '1.0.0', bundleRoot: '0xb', owner: OWNER, publisher: OWNER, riskTier: 'low', releaseId: '0xr', signature: '0xs', signed: true, publishedAt: NOW * 1000 }] },
  { id: 'art-parts', kind: 'json-ld', name: 'work.parts.json', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  { id: 'art-diary', kind: 'md', name: 'diary.md', folder: 'personal', accessPolicy: 'private', version: 1 },
  { id: 'art-near', kind: 'md', name: 'near.md', folder: 'works/restricted-other', accessPolicy: 'private', version: 1 },
];
const bodies: Record<string, string> = { 'art-restricted': LONG, 'art-parts': '{"parts":[1,2,3]}', 'art-diary': 'my private diary', 'art-near': 'neighbouring folder' };

const checks = (over: Partial<LibraryGrantChecks> & { revoked?: Set<string> } = {}): LibraryGrantChecks => ({
  enforcers: E, vaultServer: VAULT, now: () => NOW,
  delegationDigest: (d) => hashDelegation(d, CHAIN, DM),
  isRevoked: async (d) => over.revoked?.has(hashDelegation(d, CHAIN, DM)) ?? false,
  // ECDSA in place of the ERC-1271 read: the test "agent" is its key's address.
  verifySignature: async ({ signer, digest, signature }) => (await recoverAddress({ hash: digest, signature }).catch(() => '0x')).toLowerCase() === signer.toLowerCase(),
  ...over,
});
const deps = (c: LibraryGrantChecks = checks()): LibraryToolDeps => ({
  readSubjectRecord: async (subject, type) => {
    if (subject !== OWNER) return null;
    if (type === 'content.catalog') return structuredClone(catalog);
    const id = type.replace(/^content\.artifact\./, '');
    return bodies[id] !== undefined ? { id, bytesB64: enc(bodies[id]!) } : null;
  },
  grantChecks: c,
});

interface GrantOpts { delegator?: Address; delegate?: Address; signer?: Hex; window?: [number, number]; methods?: Hex[]; targets?: Address[]; scope?: string[] | null; server?: string; drop?: 'timestamp' | 'allowedMethods' | 'allowedTargets' }
/** A delegation as the owner's ceremony will sign it: `buildMethodAuthorityCaveats` + an entries scope. */
async function grantOf(o: GrantOpts = {}) {
  const delegator = o.delegator ?? OWNER;
  const win = o.window ?? [NOW - 60, NOW + 3600];
  let caveats: Caveat[] = o.methods || o.targets
    ? [
        buildCaveat(E.timestamp, encodeTimestampTerms(win[0], win[1])),
        buildCaveat(E.allowedTargets, encodeAllowedTargetsTerms(o.targets ?? [delegator])),
        buildCaveat(E.allowedMethods, encodeAllowedMethodsTerms(o.methods ?? [methodSelector(LIBRARY_GRANTED_READ)])),
      ]
    : buildMethodAuthorityCaveats({ target: delegator, method: LIBRARY_GRANTED_READ, enforcers: E, window: { validAfter: win[0], validUntil: win[1] } });
  if (o.drop) caveats = caveats.filter((c) => c.enforcer.toLowerCase() !== E[o.drop!].toLowerCase());
  if (o.scope !== null) caveats.push(buildVaultRecordScopeCaveat([{ server: o.server ?? VAULT, resources: o.scope ?? [libraryEntryScope('art-restricted'), libraryEntryScope('art-parts')], ops: ['read'] }]));
  const unsigned: Delegation = { delegator, delegate: o.delegate ?? WORKSPACE, authority: `0x${'f'.repeat(64)}` as Hex, caveats, salt: 7n, signature: '0x' };
  const digest = hashDelegation(unsigned, CHAIN, DM);
  const signature = await sign({ hash: digest, privateKey: o.signer ?? OWNER_PK, to: 'hex' });
  const d = { ...unsigned, signature };
  return { wire: { ...d, salt: d.salt.toString() }, digest, delegation: d };
}
const read = async (args: Record<string, unknown>, caller: Address = WORKSPACE, c?: LibraryGrantChecks) => grantedLibraryRead(deps(c), OWNER, caller, args) as Promise<Record<string, unknown>>;

describe('the owner reads her own long document in pages (library.file.read offset)', () => {
  it('pages exactly as the public read does, and the pages rebuild the whole text', async () => {
    const inv = libraryInvoker(deps(), OWNER, OWNER);
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const r = (await inv('library.file.read', { id: 'art-restricted', ...(offset ? { offset } : {}) }, {} as never)) as { text: string; chars: number; truncated: boolean; offset?: number };
      expect(r.chars).toBe(LONG.length);
      expect(r.offset).toBe(offset || undefined);
      pages.push(r.text);
      offset += r.text.length;
      if (!r.truncated) break;
    }
    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(LIBRARY_TEXT_MAX_CHARS);
    expect(pages.join('')).toBe(LONG);
  });
});

describe('a granted read admitted', () => {
  it('reads a private document in scope, paged, citing the grant', async () => {
    const g = await grantOf();
    const first = await read({ id: 'art-restricted', grant: g.wire });
    expect(first).toMatchObject({ read: true, owner: OWNER, chars: LONG.length, truncated: true, untrusted: true, grant: { delegationHash: g.digest, expiresAt: new Date((NOW + 3600) * 1000).toISOString() } });
    expect((first.file as { id: string; release: { releaseId: string } }).release.releaseId).toBe('0xr');
    const last = await read({ id: 'art-restricted', offset: 2 * LIBRARY_TEXT_MAX_CHARS, grant: g.wire });
    expect(last).toMatchObject({ read: true, offset: 2 * LIBRARY_TEXT_MAX_CHARS, truncated: false });
    expect(String(first.text) + String((await read({ id: 'art-restricted', offset: LIBRARY_TEXT_MAX_CHARS, grant: g.wire })).text) + String(last.text)).toBe(LONG);
    expect(await read({ id: 'art-parts', grant: g.wire })).toMatchObject({ read: true, text: '{"parts":[1,2,3]}' });
  });

  it('a folder scope reaches what is under that folder, and nothing beside it', async () => {
    const g = await grantOf({ scope: [libraryFolderScope('works/restricted')] });
    expect(await read({ id: 'art-parts', grant: g.wire })).toMatchObject({ read: true });
    expect(await read({ id: 'art-near', grant: g.wire })).toMatchObject({ read: false, refused: 'no document by that id is readable under this grant' });
  });

  it('through the Library invoker, the caller is the run\'s principal', async () => {
    const g = await grantOf();
    expect(await libraryInvoker(deps(), OWNER, WORKSPACE)(LIBRARY_GRANTED_READ, { id: 'art-parts', grant: g.wire }, {} as never)).toMatchObject({ read: true });
    expect(await libraryInvoker(deps(), OWNER, STRANGER)(LIBRARY_GRANTED_READ, { id: 'art-parts', grant: g.wire }, {} as never)).toMatchObject({ read: false, refused: expect.stringContaining('delegate') });
  });
});

describe('a granted read refused — each leg, in words', () => {
  const refusedFor = async (g: { wire: unknown }, caller: Address = WORKSPACE, c?: LibraryGrantChecks) => String((await read({ id: 'art-restricted', grant: g.wire }, caller, c)).refused);

  it('wrong delegator: a grant signed by another agent for itself', async () => {
    expect(await refusedFor(await grantOf({ delegator: OTHER, signer: OTHER_PK }))).toMatch(/not for this Library's owner/);
  });
  it('wrong delegate: the caller is not the agent the grant names', async () => {
    expect(await refusedFor(await grantOf(), STRANGER)).toMatch(/names 0xa1a1.* as its delegate, and the caller is 0xb2b2/);
  });
  it('expired, and not yet valid', async () => {
    expect(await refusedFor(await grantOf({ window: [NOW - 7200, NOW - 1] }))).toMatch(/expired at/);
    expect(await refusedFor(await grantOf({ window: [NOW + 60, NOW + 3600] }))).toMatch(/not valid until/);
    expect(await refusedFor(await grantOf({ drop: 'timestamp' }))).toMatch(/no time window/);
  });
  it('the method caveat missing, naming another method, or only the any-skill sentinel', async () => {
    expect(await refusedFor(await grantOf({ drop: 'allowedMethods' }))).toMatch(/no allowedMethods caveat/);
    expect(await refusedFor(await grantOf({ methods: [methodSelector('library.public.read')] }))).toMatch(/do not name library.granted.read/);
    expect(await refusedFor(await grantOf({ methods: [A2A_ANY_SKILL] }))).toMatch(/do not name library.granted.read/);
  });
  it('allowedTargets missing or naming another agent', async () => {
    expect(await refusedFor(await grantOf({ drop: 'allowedTargets' }))).toMatch(/no allowedTargets/);
    expect(await refusedFor(await grantOf({ targets: [STRANGER] }))).toMatch(/allowedTargets do not name/);
  });
  it('no entries scope, a scope for another vault, or a scope too broad to honor', async () => {
    expect(await refusedFor(await grantOf({ scope: null }))).toMatch(/no entries scope/);
    expect(await refusedFor(await grantOf({ server: 'another-estate' }))).toMatch(/names no document or folder/);
    expect(await refusedFor(await grantOf({ scope: ['vault:content.artifact.*', 'vault:content.folder:*'] }))).toMatch(/names no document or folder/);
  });
  it('an id outside the entries scope', async () => {
    const r = await read({ id: 'art-diary', grant: (await grantOf()).wire });
    expect(r).toMatchObject({ read: false, refused: 'no document by that id is readable under this grant' });
    expect(r.text).toBeUndefined();
  });
  it('revoked on chain, and a revocation that cannot be read', async () => {
    const g = await grantOf();
    expect(await refusedFor(g, WORKSPACE, checks({ revoked: new Set([g.digest]) }))).toMatch(/revoked on chain/);
    expect(await refusedFor(g, WORKSPACE, checks({ isRevoked: async () => { throw new Error('rpc down'); } }))).toMatch(/revoked on chain/);
  });
  it('a bad signature: signed by a key that is not the owner, or tampered after signing', async () => {
    expect(await refusedFor(await grantOf({ signer: OTHER_PK }))).toMatch(/not signed by .* \(ERC-1271\)/);
    const g = await grantOf();
    const widened = { ...g.wire, caveats: g.wire.caveats.map((c) => (c.enforcer === VAULT_RECORD_SCOPE_ENFORCER ? buildVaultRecordScopeCaveat([{ server: VAULT, resources: [libraryEntryScope('art-diary')], ops: ['read'] }]) : c)) };
    expect(String((await read({ id: 'art-diary', grant: widened })).refused)).toMatch(/not signed by/);
  });
  it('no grant at all, and no chain checks configured', async () => {
    expect(await refusedFor({ wire: undefined })).toMatch(/no grant was presented/);
    expect(String((await grantedLibraryRead({ readSubjectRecord: async () => null }, OWNER, WORKSPACE, { id: 'art-parts', grant: (await grantOf()).wire })).refused)).toMatch(/cannot verify a grant/);
  });
});

describe('unknown and not-granted are one answer', () => {
  it('a missing id and a private document outside the scope read identically', async () => {
    const g = await grantOf();
    const strip = (r: Record<string, unknown>) => JSON.stringify(r);
    const unknown = await read({ id: 'art-does-not-exist', grant: g.wire });
    const outside = await read({ id: 'art-diary', grant: g.wire });
    expect(strip(unknown)).toBe(strip(outside));
    expect(unknown).toEqual({ read: false, owner: OWNER, refused: 'no document by that id is readable under this grant', answer: 'That is not readable under this grant.' });
  });
});

describe('on the A2A task rail', () => {
  const ctxOf = (d: Delegation, sender: Address, input: Record<string, unknown>) => {
    const emitted: unknown[] = [];
    return { emitted, ctx: { taskId: '0x01', principal: d.delegator, sender, input, delegation: d, emitArtifact: async (a: { body: unknown }) => (emitted.push(a.body), '0xa1') } as never };
  };
  it('reads under the task\'s own delegation, the verified sender as the caller', async () => {
    const g = await grantOf();
    const skill = makeLibraryGrantedReadSkill(OWNER, () => deps());
    const { ctx, emitted } = ctxOf(g.delegation, WORKSPACE, { id: 'art-parts' });
    expect(await skill.handle(ctx)).toEqual({ state: 'completed', artifactIds: ['0xa1'] });
    expect(emitted[0]).toMatchObject({ read: true, text: '{"parts":[1,2,3]}', grant: { delegationHash: g.digest } });
  });
  it('fails a sender the grant does not name, and a second grant in the input', async () => {
    const g = await grantOf();
    const other = await grantOf({ scope: [libraryEntryScope('art-diary')] });
    const skill = makeLibraryGrantedReadSkill(OWNER, () => deps());
    expect(await skill.handle(ctxOf(g.delegation, STRANGER, { id: 'art-parts' }).ctx)).toMatchObject({ state: 'failed', error: expect.stringContaining('delegate') });
    expect(await skill.handle(ctxOf(g.delegation, WORKSPACE, { id: 'art-diary', grant: other.wire }).ctx)).toMatchObject({ state: 'failed', error: expect.stringContaining('ONE grant') });
  });
});
