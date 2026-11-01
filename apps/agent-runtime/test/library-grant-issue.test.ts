// Slice S4 — THE OWNER ISSUES THE GRANT a granted read (S2, #74) admits, lists it, and revokes it. The grant is signed by
// the OWNER's custody credential — supplied on a signature prompt (here: an ECDSA test key standing in for the owner's SA,
// recovered in place of the ERC-1271 read) or approved in the mandate's one prompt (the 0x03 sentinel) — and never under
// the agent's session leaf. Every issued wire is fed straight back through `grantedLibraryRead` to prove it is exactly the
// grant #74 admits, inside its scope and nowhere else.
import { describe, expect, it } from 'vitest';
import { recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { hashDelegation, intentDigest, ROOT_AUTHORITY, type EnforcerAddressMap } from '@agenticprimitives/delegation';
import { InputRequired } from '@agenticprimitives/orchestration';
import {
  libraryInvoker, grantedLibraryRead, libraryGrantFor, libraryGrantPlan, libraryEntryScope, libraryFolderScope,
  LIBRARY_GRANT_ISSUE, LIBRARY_GRANTS_LIST, LIBRARY_GRANT_REVOKE, LIBRARY_GRANT_RECORD, LIBRARY_TOOLS,
  type LibraryEntry, type LibraryGrantChecks, type LibraryToolDeps, type LibraryGrantWire, type LibraryGrantRecordV1,
} from '../src/library-tools.js';
import { CAPABILITY_CEREMONIES, ceremoniesFor, HARNESS_ACTION_TOOLS } from '../src/harness-run.js';
import { preconditionRefusal } from '../src/capability-preconditions.js';

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const OTHER_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const OWNER = privateKeyToAccount(OWNER_PK).address.toLowerCase() as Address; // the publisher (a person publishing as herself)
const OTHER = privateKeyToAccount(OTHER_PK).address.toLowerCase() as Address;
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
const enc = (t: string) => btoa(unescape(encodeURIComponent(t)));

const seed = (): LibraryEntry[] => [
  { id: 'art-restricted', kind: 'md', name: 'work.md', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  { id: 'art-parts', kind: 'json-ld', name: 'work.parts.json', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  { id: 'art-diary', kind: 'md', name: 'diary.md', folder: 'personal', accessPolicy: 'private', version: 1 },
  { id: 'art-near', kind: 'md', name: 'near.md', folder: 'works/restricted-other', accessPolicy: 'private', version: 1 },
];
const bodies: Record<string, string> = { 'art-restricted': 'the restricted text', 'art-parts': '{"parts":[1,2,3]}', 'art-diary': 'my private diary', 'art-near': 'neighbouring folder' };

/** A Library whose catalog the acts really write, and a chain whose revocations the test controls. */
function world(opts: { approved?: Set<string>; revokedOnChain?: Set<string> } = {}) {
  let catalog = seed();
  const revoked = opts.revokedOnChain ?? new Set<string>();
  const approved = opts.approved ?? new Set<string>();
  const revokes: LibraryGrantWire[] = [];
  const checks: LibraryGrantChecks = {
    enforcers: E, vaultServer: VAULT, now: () => NOW,
    delegationDigest: (d) => hashDelegation(d, CHAIN, DM),
    isRevoked: async (d) => revoked.has(hashDelegation(d, CHAIN, DM)),
    // ERC-1271 as the owner's account answers it: the approved-hash sentinel for a digest it approved, else its custodian's
    // signature (an ECDSA test key standing in for the custody credential).
    verifySignature: async ({ signer, digest, signature }) => (signature === '0x03'
      ? signer.toLowerCase() === OWNER && approved.has(digest)
      : (await recoverAddress({ hash: digest, signature }).catch(() => '0x')).toLowerCase() === signer.toLowerCase()),
  };
  const deps = (over: Partial<LibraryToolDeps> = {}): LibraryToolDeps => ({
    readSubjectRecord: async (subject, type) => {
      if (subject !== OWNER) return null;
      if (type === 'content.catalog') return structuredClone(catalog);
      const id = type.replace(/^content\.artifact\./, '');
      return bodies[id] !== undefined ? { id, bytesB64: enc(bodies[id]!) } : null;
    },
    writeSubjectRecord: async (subject, type, record) => {
      if (subject !== OWNER) return { ok: false, error: 'not yours' };
      if (type === 'content.catalog') catalog = structuredClone(record as LibraryEntry[]);
      return { ok: true };
    },
    grantChecks: checks,
    mandate: { delegator: OWNER, validAfter: NOW - 60 },
    approvedHash: async (owner, digest) => owner === OWNER && approved.has(digest),
    revokeOnChain: async (grant) => { revokes.push(grant); revoked.add(hashDelegation({ ...grant, salt: BigInt(grant.salt) } as never, CHAIN, DM)); return { txHash: '0xrevoke' }; },
    ...over,
  });
  return { deps, checks, revoked, approved, revokes, catalog: () => catalog };
}

const INTENT = { goal: 'grant my workspace a read of the restricted work', context: {} };
const ctx = (supplied: unknown[] = []) => ({ step: { id: 's0' }, index: 0, intent: INTENT, supplied } as never);
const digestOf = (asked: unknown) => String((asked as { request?: { digest?: string } }).request?.digest ?? (asked as { digest?: string }).digest);

/** Ask, be parked for the owner's signature, sign as the owner's credential, and resume — the Home's prompt path. */
async function issue(w: ReturnType<typeof world>, args: Record<string, unknown>, signer: Hex = OWNER_PK, depsOver: Partial<LibraryToolDeps> = {}) {
  const inv = libraryInvoker(w.deps(depsOver), OWNER, OWNER);
  const asked = await inv(LIBRARY_GRANT_ISSUE, args, ctx()).catch((e: unknown) => e);
  if (!(asked instanceof InputRequired)) return { out: asked as Record<string, unknown>, asked: null };
  const digest = digestOf(asked) as Hex;
  const signature = await sign({ hash: digest, privateKey: signer, to: 'hex' });
  const out = (await inv(LIBRARY_GRANT_ISSUE, args, ctx([{ stepRef: 's0', signature: { digest, signer: OWNER, signature } }]))) as Record<string, unknown>;
  return { out, asked };
}
const read = (w: ReturnType<typeof world>, id: string, grant: unknown, caller: Address = WORKSPACE) => grantedLibraryRead(w.deps(), OWNER, caller, { id, grant }) as Promise<Record<string, unknown>>;

describe('library.grant.issue is consequential: declared, parked, never self-acting', () => {
  it('needs the owner\'s mandate and a signature — the service.create mechanism', () => {
    const tool = HARNESS_ACTION_TOOLS.find((t) => t.id === LIBRARY_GRANT_ISSUE)!;
    expect(tool.capability).toMatchObject({ id: LIBRARY_GRANT_ISSUE, resourceArg: 'delegate', authorityArg: 'holder' });
    expect(tool.selfAuthorized).toBeFalsy();
    expect(tool.risk).toBe('medium');
    expect(CAPABILITY_CEREMONIES[LIBRARY_GRANT_ISSUE]).toEqual(['signature']);
    expect(ceremoniesFor(LIBRARY_GRANT_REVOKE)).toEqual(['signature']);
    expect(HARNESS_ACTION_TOOLS.find((t) => t.id === LIBRARY_GRANT_REVOKE)!.capability).toMatchObject({ redeemsOnChain: true, resourceArg: 'manager' });
    expect(LIBRARY_TOOLS.find((t) => t.id === LIBRARY_GRANTS_LIST)!.capability).toBeUndefined();
  });

  it('with no signature and no approval the step PARKS on a signature prompt for the owner, over the grant digest', async () => {
    const w = world();
    const asked = await libraryInvoker(w.deps(), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 }, ctx()).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(InputRequired);
    const req = (asked as InputRequired).request as { kind: string; signer: string; digest: string; toolId: string; payload: { delegate: string; resources: string[] } };
    expect(req).toMatchObject({ kind: 'signature', signer: OWNER, toolId: LIBRARY_GRANT_ISSUE, payload: { delegate: WORKSPACE, resources: [libraryEntryScope('art-restricted')] } });
    // The digest the parked reply names in `alsoApprove` (derived from the mandate's intent + window) is the one the step signs.
    const plan = libraryGrantPlan(OWNER, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 });
    if ('refused' in plan) throw new Error(plan.refused);
    expect(libraryGrantFor(w.checks, OWNER, plan, { intentDigest: intentDigest(INTENT), validAfter: NOW - 60 }, 's0').digest).toBe(req.digest);
    expect(w.catalog().every((e) => !e.grants?.length)).toBe(true); // nothing recorded until it is signed
  });

  it('is refused without a mandate, and under a mandate that is not the owner\'s', async () => {
    const w = world();
    await expect(libraryInvoker(w.deps({ mandate: undefined }), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 }, ctx())).rejects.toThrow(/requires a mandate/);
    expect(await libraryInvoker(w.deps({ mandate: { delegator: OTHER, validAfter: NOW } }), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 }, ctx())).toMatchObject({ refused: expect.stringContaining('owner\'s own mandate') });
  });
});

describe('an issued grant is exactly the grant #74 admits', () => {
  it('a document grant: signed on the prompt, recorded on the entry, read by the delegate — and only that document', async () => {
    const w = world();
    const { out } = await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 });
    expect(out).toMatchObject({ issued: true, owner: OWNER, resources: [libraryEntryScope('art-restricted')], expiresAt: new Date((NOW - 60 + 30 * 86_400) * 1000).toISOString(), recordedOn: { id: 'art-restricted', isFolder: false } });
    const grant = out.grant as LibraryGrantWire;
    expect(grant).toMatchObject({ delegator: OWNER, delegate: WORKSPACE, authority: ROOT_AUTHORITY });
    expect(typeof grant.salt).toBe('string');
    expect(grant.caveats.every((c) => typeof c.args === 'string')).toBe(true);
    expect(out.delegationHash).toBe(hashDelegation({ ...grant, salt: BigInt(grant.salt) } as never, CHAIN, DM));

    expect(await read(w, 'art-restricted', grant)).toMatchObject({ read: true, text: 'the restricted text', grant: { delegationHash: out.delegationHash } });
    expect(await read(w, 'art-parts', grant)).toMatchObject({ read: false, refused: 'no document by that id is readable under this grant' });
    expect(await read(w, 'art-restricted', grant, STRANGER)).toMatchObject({ read: false, refused: expect.stringContaining('delegate') });

    const rec = w.catalog().find((e) => e.id === 'art-restricted')!.grants![0] as LibraryGrantRecordV1;
    expect(rec).toMatchObject({ type: LIBRARY_GRANT_RECORD, delegationHash: out.delegationHash, delegate: WORKSPACE, resources: [libraryEntryScope('art-restricted')], issuedBy: OWNER, validUntil: out.expiresAt, grant });
    expect(typeof rec.issuedAt).toBe('string');
  });

  it('a folder grant: recorded on a folder entry made for it, reaches what is under the folder and nothing beside it', async () => {
    const w = world();
    const { out } = await issue(w, { folder: '/works/restricted/', delegate: WORKSPACE, validDays: 7 });
    expect(out).toMatchObject({ issued: true, resources: [libraryFolderScope('works/restricted')], recordedOn: { path: 'works/restricted', isFolder: true } });
    const folder = w.catalog().find((e) => e.isFolder && e.folder === 'works' && e.name === 'restricted')!;
    expect(folder.accessPolicy).toBeUndefined(); // the folder entry declares nothing: no one's view changes
    expect((folder.grants![0] as LibraryGrantRecordV1).scope).toEqual({ folder: 'works/restricted' });
    expect(await read(w, 'art-parts', out.grant)).toMatchObject({ read: true });
    expect(await read(w, 'art-restricted', out.grant)).toMatchObject({ read: true });
    expect(await read(w, 'art-near', out.grant)).toMatchObject({ read: false, refused: 'no document by that id is readable under this grant' });
    expect(await read(w, 'art-diary', out.grant)).toMatchObject({ read: false });
  });

  it('the one-prompt path: approved beside the mandate (0x03) — no second prompt, and it verifies as the owner', async () => {
    const plan = libraryGrantPlan(OWNER, { id: 'art-parts', delegate: WORKSPACE, validDays: 1 });
    if ('refused' in plan) throw new Error(plan.refused);
    const w0 = world();
    const digest = libraryGrantFor(w0.checks, OWNER, plan, { intentDigest: intentDigest(INTENT), validAfter: NOW - 60 }, 's0').digest;
    const w = world({ approved: new Set([digest]) });
    const out = (await libraryInvoker(w.deps(), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, { id: 'art-parts', delegate: WORKSPACE, validDays: 1 }, ctx())) as Record<string, unknown>;
    expect(out).toMatchObject({ issued: true, delegationHash: digest, grant: { signature: '0x03' } });
    expect(await read(w, 'art-parts', out.grant)).toMatchObject({ read: true });
  });

  it('a supplied signature that is not the owner\'s is refused, and nothing is recorded', async () => {
    const w = world();
    const { out } = await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 }, OTHER_PK);
    expect(out).toMatchObject({ issued: false, refused: expect.stringMatching(/does not verify as .* \(ERC-1271\)/) });
    expect(w.catalog().every((e) => !e.grants?.length)).toBe(true);
  });

  it('resuming the same step again is idempotent: one record, the same grant', async () => {
    const w = world();
    const first = await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 });
    const again = await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 });
    expect(again.out).toMatchObject({ issued: true, alreadyIssued: true, delegationHash: first.out.delegationHash });
    expect(w.catalog().find((e) => e.id === 'art-restricted')!.grants).toHaveLength(1);
  });
});

describe('library.grant.issue refusals, in words', () => {
  const refusedFor = async (args: Record<string, unknown>) => String(((await libraryInvoker(world().deps(), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, args, ctx())) as { refused?: string }).refused);
  it('an unknown document or folder (the owner is asking, so it is named)', async () => {
    expect(await refusedFor({ id: 'art-missing', delegate: WORKSPACE, validDays: 3 })).toMatch(/no document with id "art-missing"/);
    expect(await refusedFor({ folder: 'works/nowhere', delegate: WORKSPACE, validDays: 3 })).toMatch(/no folder "works\/nowhere"/);
  });
  it('a delegate that is not an address, or is the owner itself', async () => {
    expect(await refusedFor({ id: 'art-parts', delegate: 'workspace.svc', validDays: 3 })).toMatch(/Smart Agent address/);
    expect(await refusedFor({ id: 'art-parts', delegate: OWNER, validDays: 3 })).toMatch(/cannot be its own delegate/);
  });
  it('validDays out of range or not a whole number', async () => {
    for (const validDays of [0, 366, 2.5, 'soon', undefined]) expect(await refusedFor({ id: 'art-parts', delegate: WORKSPACE, validDays })).toMatch(/validDays is a whole number of days from 1 to 365/);
    // a numeric string is a number of days: not refused — it parks for the owner's signature
    await expect(libraryInvoker(world().deps(), OWNER, OWNER)(LIBRARY_GRANT_ISSUE, { id: 'art-parts', delegate: WORKSPACE, validDays: '30' }, ctx())).rejects.toBeInstanceOf(InputRequired);
  });
  it('an empty folder path, both a document and a folder, or neither', async () => {
    expect(await refusedFor({ folder: '/', delegate: WORKSPACE, validDays: 3 })).toMatch(/empty path would be the whole Library/);
    expect(await refusedFor({ id: 'art-parts', folder: 'works', delegate: WORKSPACE, validDays: 3 })).toMatch(/not both/);
    expect(await refusedFor({ delegate: WORKSPACE, validDays: 3 })).toMatch(/names the document .* or the folder/);
  });
  it('the precondition refuses the same BEFORE the owner is asked to sign a mandate', async () => {
    const w = world();
    const pre = (capability: string, args: Record<string, unknown>) => preconditionRefusal({ capability, args, env: {} as never, deps: { readSubjectRecord: w.deps().readSubjectRecord } as never, addressee: OWNER });
    expect(await pre(LIBRARY_GRANT_ISSUE, { id: 'art-missing', delegate: WORKSPACE, validDays: 3 })).toMatch(/no document with id "art-missing".*Nothing was authorized/);
    expect(await pre(LIBRARY_GRANT_ISSUE, { id: 'art-parts', delegate: OWNER, validDays: 3 })).toMatch(/own delegate/);
    expect(await pre(LIBRARY_GRANT_ISSUE, { id: 'art-parts', delegate: WORKSPACE, validDays: 3 })).toBeNull();
    expect(await pre(LIBRARY_GRANT_REVOKE, { delegationHash: '0x' + '9'.repeat(64) })).toMatch(/no grant 0x9999.* was issued/);
  });
});

describe('library.grants.list — the owner\'s read', () => {
  it('shows each grant with its signed wire, live revocation, and the delegate / entry filters', async () => {
    const w = world();
    const a = (await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 })).out;
    const b = (await issue(w, { folder: 'personal', delegate: STRANGER, validDays: 2 })).out;
    const inv = libraryInvoker(w.deps(), OWNER, OWNER);
    const all = (await inv(LIBRARY_GRANTS_LIST, {}, ctx())) as { count: number; grants: Array<Record<string, unknown>> };
    expect(all.count).toBe(2);
    const mine = (await inv(LIBRARY_GRANTS_LIST, { delegate: WORKSPACE.toUpperCase().replace('0X', '0x') }, ctx())) as { count: number; grants: Array<Record<string, unknown>> };
    expect(mine.count).toBe(1);
    expect(mine.grants[0]).toMatchObject({ delegationHash: a.delegationHash, delegate: WORKSPACE, resources: [libraryEntryScope('art-restricted')], revoked: false, expired: false, issuedBy: OWNER, entry: { id: 'art-restricted' }, grant: a.grant });
    // The wire the list hands back is the one a workspace presents: it reads.
    expect(await read(w, 'art-restricted', mine.grants[0]!.grant)).toMatchObject({ read: true });
    const folderId = w.catalog().find((e) => e.isFolder && e.name === 'personal')!.id;
    expect(((await inv(LIBRARY_GRANTS_LIST, { id: folderId }, ctx())) as { grants: Array<{ delegationHash: string }> }).grants.map((g) => g.delegationHash)).toEqual([b.delegationHash]);
    expect(await inv(LIBRARY_GRANTS_LIST, { id: 'nope' }, ctx())).toMatchObject({ count: 0, refused: expect.stringContaining('no entry') });
  });
  it('is the owner\'s (or a steward\'s): anyone else is refused', async () => {
    const w = world();
    expect(await libraryInvoker(w.deps(), OWNER, STRANGER)(LIBRARY_GRANTS_LIST, {}, ctx())).toMatchObject({ refused: expect.stringContaining('its own agent or by a steward') });
    expect(await libraryInvoker(w.deps({ stewardOf: async () => ({ steward: true, because: 'test' }) }), OWNER, STRANGER)(LIBRARY_GRANTS_LIST, {}, ctx())).toMatchObject({ count: 0 });
  });
});

describe('library.grant.revoke — on chain, as the owner', () => {
  it('revokes with the full stored struct; the granted read is then refused as revoked; the list says so', async () => {
    const w = world();
    const { out } = await issue(w, { id: 'art-restricted', delegate: WORKSPACE, validDays: 30 });
    const inv = libraryInvoker(w.deps(), OWNER, OWNER);
    const r = (await inv(LIBRARY_GRANT_REVOKE, { delegationHash: out.delegationHash }, ctx())) as Record<string, unknown>;
    expect(r).toMatchObject({ revoked: true, txHash: '0xrevoke', delegate: WORKSPACE, delegationHash: out.delegationHash });
    expect(w.revokes).toEqual([out.grant]); // the whole signed struct, as revokeDelegationByOwner takes it
    expect(String((await read(w, 'art-restricted', out.grant)).refused)).toMatch(/revoked on chain/);
    const rec = w.catalog().find((e) => e.id === 'art-restricted')!.grants![0] as LibraryGrantRecordV1;
    expect(rec).toMatchObject({ revokedBy: OWNER, revokeTx: '0xrevoke' });
    expect(typeof rec.revokedAt).toBe('string');
    expect(((await inv(LIBRARY_GRANTS_LIST, {}, ctx())) as { grants: Array<Record<string, unknown>> }).grants[0]).toMatchObject({ revoked: true, revokeTx: '0xrevoke' });
    // Twice is a fact, not a second transaction.
    expect(await inv(LIBRARY_GRANT_REVOKE, { delegationHash: out.delegationHash }, ctx())).toMatchObject({ revoked: true, alreadyRevoked: true });
    expect(w.revokes).toHaveLength(1);
  });
  it('refuses a malformed or unknown digest, and needs the owner\'s mandate', async () => {
    const w = world();
    const inv = libraryInvoker(w.deps(), OWNER, OWNER);
    expect(await inv(LIBRARY_GRANT_REVOKE, { delegationHash: 'abc' }, ctx())).toMatchObject({ revoked: false, refused: expect.stringContaining('64 hex') });
    expect(await inv(LIBRARY_GRANT_REVOKE, { delegationHash: '0x' + '9'.repeat(64) }, ctx())).toMatchObject({ revoked: false, refused: expect.stringContaining('was issued from this Library') });
    await expect(libraryInvoker(w.deps({ mandate: undefined }), OWNER, OWNER)(LIBRARY_GRANT_REVOKE, { delegationHash: '0x' + '9'.repeat(64) }, ctx())).rejects.toThrow(/requires a mandate/);
  });
});
