// SLICE S4 ON A PAGED LIBRARY. A read grant is recorded on a catalog entry (`grants[]`), so issuing or revoking one is a
// catalog write like any other: for a PAGED owner it is the one-page edit, by id, under the lease — the root and the one
// page that holds the entry (or the root alone, for a folder entry) — and a legacy owner is written exactly as before.
// Both are run side by side and must leave the same Library.
import { describe, expect, it } from 'vitest';
import { recoverAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { hashDelegation, type EnforcerAddressMap } from '@agenticprimitives/delegation';
import { InputRequired } from '@agenticprimitives/orchestration';
import { libraryInvoker, LIBRARY_GRANT_ISSUE, LIBRARY_GRANT_REVOKE, type LibraryEntry, type LibraryGrantChecks, type LibraryGrantRecordV1, type LibraryToolDeps } from '../src/library-tools.js';
import { expandCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, applyCatalogEdit, buildPagedCatalog, newGeneration, pageOf, pageRecordOf, pageRows, readCatalog, type CatalogRoot } from '../src/catalog-pages.js';

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const OWNER = privateKeyToAccount(OWNER_PK).address.toLowerCase() as Address;
const WORKSPACE = ('0x' + 'a1'.repeat(20)) as Address;
const CHAIN = 34348;
const DM = ('0x' + 'd0'.repeat(20)) as Address;
const E: EnforcerAddressMap = { delegationManager: DM, timestamp: ('0x' + '11'.repeat(20)) as Address, value: ('0x' + '12'.repeat(20)) as Address, allowedTargets: ('0x' + '13'.repeat(20)) as Address, allowedMethods: ('0x' + '14'.repeat(20)) as Address };
const NOW = 1_800_000_000;

const library = (): LibraryEntry[] => [
  { id: 'f-works', kind: 'md', name: 'works', folder: '', isFolder: true },
  { id: 'art-restricted', kind: 'md', name: 'work.md', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  { id: 'art-parts', kind: 'json-ld', name: 'work.parts.json', folder: 'works/restricted', accessPolicy: 'private', version: 1 },
  ...Array.from({ length: 200 }, (_, i) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: `shelf/${i % 9}`, version: 1 })),
];

function chain() {
  const revoked = new Set<string>();
  const checks: LibraryGrantChecks = {
    enforcers: E, vaultServer: 'demo-mcp', now: () => NOW,
    delegationDigest: (d) => hashDelegation(d, CHAIN, DM),
    isRevoked: async (d) => revoked.has(hashDelegation(d, CHAIN, DM)),
    verifySignature: async ({ signer, digest, signature }) => (await recoverAddress({ hash: digest, signature }).catch(() => '0x')).toLowerCase() === signer.toLowerCase(),
  };
  const grantDeps: Partial<LibraryToolDeps> = {
    grantChecks: checks,
    mandate: { delegator: OWNER, validAfter: NOW - 60 },
    revokeOnChain: async (grant) => { revoked.add(hashDelegation({ ...grant, salt: BigInt(grant.salt) } as never, CHAIN, DM)); return { txHash: '0xrevoke' }; },
  };
  return grantDeps;
}

/** A PAGED owner: the vault's records, the page store (the DO's edit, applied as the object applies it), and a ledger. */
async function pagedOwner() {
  const records = new Map<string, unknown>();
  const built = await buildPagedCatalog(library(), { gen: newGeneration(1), active: true, now: 1 });
  for (const w of built.pages) records.set(w.recordType, w.data);
  records.set(CATALOG_ROOT_RECORD, built.root);
  const ledger = { reads: [] as string[], writes: [] as string[] };
  const root = () => records.get(CATALOG_ROOT_RECORD) as CatalogRoot;
  const deps: LibraryToolDeps = {
    ...chain(),
    readSubjectRecord: async (_s, t) => { ledger.reads.push(`whole:${t}`); return structuredClone(records.get(t) ?? null); },
    writeSubjectRecord: async (_s, t, r) => {
      if (t.startsWith('content.catalog')) throw new Error(`a paged grant wrote ${t} directly`);
      ledger.writes.push(t); records.set(t, structuredClone(r)); return { ok: true };
    },
    catalogStore: {
      read: async (_o, rt) => { ledger.reads.push(rt); const d = records.get(rt) ?? null; return { ok: true, data: rt === CATALOG_ROOT_RECORD ? structuredClone(d) : expandCatalog(structuredClone(d)) }; },
      edit: async (_o, upserts) => {
        const r0 = root();
        const plan = await applyCatalogEdit(r0, async (k) => { const n = pageRecordOf(r0, k); return pageRows(r0, k, n ? records.get(n) : null); }, structuredClone(upserts), { gen: newGeneration(r0.seq + 1), now: 2 });
        for (const w of plan.pages) { ledger.writes.push(`page${w.k}`); records.set(w.recordType, w.data); }
        ledger.writes.push(CATALOG_ROOT_RECORD); records.set(CATALOG_ROOT_RECORD, plan.root);
        return { ok: true };
      },
    },
  };
  const catalog = async () => (await readCatalog({ root: async () => ({ data: records.get(CATALOG_ROOT_RECORD), rev: 0, deleted: false }), legacy: async () => null, records: async (rts) => rts.map((rt) => records.get(rt) ?? null) })) as LibraryEntry[];
  const reset = () => { ledger.reads = []; ledger.writes = []; };
  return { deps, ledger, catalog, reset };
}

function legacyOwner() {
  let catalog = library();
  const deps: LibraryToolDeps = {
    ...chain(),
    readSubjectRecord: async (_s, t) => (t === 'content.catalog' ? structuredClone(catalog) : null),
    writeSubjectRecord: async (_s, t, r) => { if (t === 'content.catalog') catalog = structuredClone(r as LibraryEntry[]); return { ok: true }; },
  };
  return { deps, catalog: async () => catalog };
}

const ctx = (supplied: unknown[] = []) => ({ step: { id: 's0' }, index: 0, intent: { goal: 'grant my workspace a read', context: {} }, supplied } as never);
async function issue(deps: LibraryToolDeps, args: Record<string, unknown>) {
  const inv = libraryInvoker(deps, OWNER, OWNER);
  const asked = await inv(LIBRARY_GRANT_ISSUE, args, ctx()).catch((e: unknown) => e);
  if (!(asked instanceof InputRequired)) return asked as Record<string, unknown>;
  const digest = String((asked as { request?: { digest?: string } }).request?.digest ?? (asked as { digest?: string }).digest) as Hex;
  const signature = await sign({ hash: digest, privateKey: OWNER_PK, to: 'hex' });
  return (await inv(LIBRARY_GRANT_ISSUE, args, ctx([{ stepRef: 's0', signature: { digest, signer: OWNER, signature } }]))) as Record<string, unknown>;
}
const revoke = (deps: LibraryToolDeps, delegationHash: string) => libraryInvoker(deps, OWNER, OWNER)(LIBRARY_GRANT_REVOKE, { delegationHash }, ctx()) as Promise<Record<string, unknown>>;
/** The catalog with the per-run timestamps a grant record carries taken out, for comparing two runs. */
const comparable = (l: LibraryEntry[]) => JSON.parse(JSON.stringify(l.map((e) => (e.isFolder && e.id.startsWith('art-') ? { ...e, id: '(minted)' } : e)), (k, v) => (k === 'issuedAt' || k === 'revokedAt' || k === 'createdAt' ? undefined : v)));

describe('a read grant on a PAGED owner is a one-page edit, by id', () => {
  it('issue on a document: reads the root and that document\'s page; writes that page and the root — never the whole list', async () => {
    const o = await pagedOwner();
    o.reset();
    const out = await issue(o.deps, { id: 'art-restricted', delegate: WORKSPACE, validDays: 7 });
    expect(out).toMatchObject({ issued: true, recordedOn: { id: 'art-restricted' } });
    expect(o.ledger.reads.filter((r) => r.startsWith('whole:content.catalog'))).toEqual([]);
    expect(o.ledger.writes.sort()).toEqual([`page${pageOf('art-restricted')}`, CATALOG_ROOT_RECORD].sort());
    const e = (await o.catalog()).find((x) => x.id === 'art-restricted')!;
    expect((e.grants![0] as LibraryGrantRecordV1).delegationHash).toBe(out.delegationHash);
  });

  it('issue on a folder with no folder entry yet: the new folder entry lands in the root — no page is written', async () => {
    const o = await pagedOwner();
    o.reset();
    const out = await issue(o.deps, { folder: 'works/restricted', delegate: WORKSPACE, validDays: 7 });
    expect(out).toMatchObject({ issued: true, recordedOn: { path: 'works/restricted', isFolder: true } });
    expect(o.ledger.writes).toEqual([CATALOG_ROOT_RECORD]);
    expect((await o.catalog()).at(-1)).toMatchObject({ name: 'restricted', folder: 'works', isFolder: true });
  });

  it('revoke: finds the grant page by page, writes that page and the root', async () => {
    const o = await pagedOwner();
    const out = await issue(o.deps, { id: 'art-parts', delegate: WORKSPACE, validDays: 7 });
    o.reset();
    expect(await revoke(o.deps, String(out.delegationHash))).toMatchObject({ revoked: true, txHash: '0xrevoke' });
    expect(o.ledger.writes.sort()).toEqual([`page${pageOf('art-parts')}`, CATALOG_ROOT_RECORD].sort());
    const g = (await o.catalog()).find((x) => x.id === 'art-parts')!.grants![0] as LibraryGrantRecordV1;
    expect(g.revokedAt).toBeTruthy();
    expect(g.revokeTx).toBe('0xrevoke');
  });
});

describe('a legacy owner is written as before — and both leave the same Library', () => {
  it('issue (document and folder) then revoke: the paged and the whole-list Library end up identical', async () => {
    const p = await pagedOwner();
    const l = legacyOwner();
    for (const o of [p, l]) {
      const a = await issue(o.deps, { id: 'art-restricted', delegate: WORKSPACE, validDays: 7 });
      await issue(o.deps, { folder: 'works/restricted', delegate: WORKSPACE, validDays: 3 });
      await revoke(o.deps, String(a.delegationHash));
    }
    expect(comparable(await p.catalog())).toEqual(comparable(await l.catalog()));
    expect(((await l.catalog()).find((x) => x.id === 'art-restricted')!.grants![0] as LibraryGrantRecordV1).revokedAt).toBeTruthy();
  });

  it('refusals are the same words (unknown document, unknown folder, unknown grant)', async () => {
    const p = await pagedOwner();
    const l = legacyOwner();
    for (const args of [{ id: 'art-none', delegate: WORKSPACE, validDays: 3 }, { folder: 'works/nowhere', delegate: WORKSPACE, validDays: 3 }]) {
      expect(await issue(p.deps, args)).toEqual(await issue(l.deps, args));
    }
    expect(await revoke(p.deps, '0x' + 'ab'.repeat(32))).toEqual(await revoke(l.deps, '0x' + 'ab'.repeat(32)));
  });
});
