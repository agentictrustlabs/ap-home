// THE LIBRARY INDEX'S SEAM IN THE PRINCIPAL'S OBJECT (catalog-pages.ts, interactions-do.ts), driven against the VAULT'S
// OWN CODE — its encrypted store and SQL on node:sqlite and the record semantics its tools apply (apps/vault
// catalog-store.ts) — never a mock that reimplements them. An owner switched to pages is read and written as pages; an
// owner who is not is read and written exactly as before; the switch copies, verifies and only then flips; the rollback
// carries every later save back and refuses rather than overwrite a legacy record that moved.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { InteractionsDO, type InteractionsDeps, REQUIRED_SCOPES } from '../src/interactions-do.js';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';
import { compactCatalog, expandCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, pageOf, pageRecordOf, type CatalogRoot } from '../src/catalog-pages.js';
import { sqliteAvailable, sqliteVault, vaultTools } from '../../vault/test/support/sqlite-vault.js';
import { writeVaultRecord } from '../../vault/src/catalog-store.js';

const PERSON = '0x1111111111111111111111111111111111111111';
const MARKER = 'test-internal-marker';
const CHAIN = 84532;
const BROKER_ISS = 'https://home.example.test';
const AUD = 'demo-sso';
const KID = 'paged-key-1';

const doc = (i: number, extra: Record<string, unknown> = {}) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'shelf', size: i, version: 1, createdAt: 1000 + i, ...(i % 4 === 0 ? { releases: [{ releaseId: `0xr${i}`, version: '1.0.0', signature: '0x51' + 'ab'.repeat(400) + i.toString(16).padStart(8, '0'), signed: true }] } : {}), ...extra });
const folder = { id: 'f-shelf', kind: 'md', name: 'shelf', folder: '', isFolder: true };
const catalog = (n: number): Array<Record<string, unknown>> => [folder, ...Array.from({ length: n }, (_, i) => doc(i))];

type Fail = (tool: string, args: Record<string, unknown>) => boolean;
/** Where an injected failure strikes: before the vault runs the call, or after it ran (the answer is lost). */
type Mode = 'before' | 'after';

function world() {
  const { vault, exec } = sqliteVault();
  const tools = vaultTools(vault, PERSON);
  const log: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fail: { when: Fail | null; mode: Mode } = { when: null, mode: 'before' };
  const deps: InteractionsDeps = {
    async erc1271() { return true; },
    async vaultTool(_g, tool, args) {
      const a = args as Record<string, unknown>;
      log.push({ tool, args: a });
      const strike = !!fail.when?.(tool, a);
      if (strike && fail.mode === 'before') return new Response(JSON.stringify({ error: 'internal error', detail: 'injected failure' }), { status: 500 });
      const out = await tools(tool, a);
      if (strike) return new Response(JSON.stringify({ error: 'internal error', detail: 'injected failure after the call ran' }), { status: 500 });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
    },
  };
  const cav = buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources: [...REQUIRED_SCOPES, 'vault:content.*'], ops: ['read', 'write'] }] as never);
  const grant = { delegator: PERSON, delegate: '0x4444444444444444444444444444444444444444', authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: cav.enforcer, terms: cav.terms, args: '0x' }], salt: '0', signature: `0x${'ab'.repeat(65)}` };
  const m = new Map<string, unknown>([['state', { grant }]]);
  const mkObj = () => new InteractionsDO(
    { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string | string[]) { for (const x of [k].flat()) m.delete(x); }, async list() { return new Map(); } } } as never,
    { RPC_URL: 'https://rpc.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.test', A2A_INTERNAL_MARKER: MARKER, BROKER_ISS, BROKER_JWKS_URL: `${BROKER_ISS}/.well-known/jwks.json`, DEMO_SSO_AUD: AUD } as never,
    deps,
  );
  let obj = mkObj();
  const raw = async (name: string, body: Record<string, unknown>, internal = true) => {
    const res = await obj.fetch(new Request(`https://do/interactions/${PERSON}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(internal ? { 'x-ap-internal': MARKER } : {}) }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const op = async (name: string, body: Record<string, unknown>) => (await raw(name, body)).body;
  const stored = async (rt: string) => vault.readStored(PERSON, `vault:${rt}`);
  const root = async () => (await stored(CATALOG_ROOT_RECORD))?.data as CatalogRoot | undefined;
  const legacy = async () => expandCatalog((await stored('content.catalog'))?.data ?? null);
  /** Every page-record write and root swap the object asked the vault for. */
  const commits = () => log.filter((l) => l.tool === 'catalog_commit').map((l) => (l.args.op === 'pages' ? `pages:${(l.args.writes as unknown[]).length}` : String(l.args.op)));
  const legacyWrites = () => log.filter((l) => l.tool === 'set_vault_record' && l.args.recordType === 'content.catalog').length;
  const clear = () => { log.length = 0; };
  /** A fresh object over the same vault (its held minute gone) — what any reader after this one sees. */
  const restart = () => { obj = mkObj(); };
  const seedLegacy = async (list: unknown[]) => expect(await writeVaultRecord(vault, PERSON, 'content.catalog', compactCatalog(list))).toEqual({ ok: true });
  /** A SECOND object over the same vault — another isolate of the same principal, with its own held minute. */
  const second = () => {
    const o = mkObj();
    return async (name: string, body: Record<string, unknown>) => (await (await o.fetch(new Request(`https://do/interactions/${PERSON}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': MARKER }, body: JSON.stringify(body) }))).json()) as Record<string, unknown>;
  };
  return { vault, exec, log, fail, op, raw, stored, root, legacy, commits, legacyWrites, clear, restart, seedLegacy, second };
}
type World = ReturnType<typeof world>;
const paged = (w: World, action: string) => w.op('internal.library.paged', { action, owner: PERSON });
const readCatalog = async (w: World) => (await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' })).data;

/** Prepare, verify and activate an owner whose legacy record is `list`. */
async function switched(list: unknown[]): Promise<World> {
  const w = world();
  await w.seedLegacy(list);
  expect((await paged(w, 'prepare')).ok).toBe(true);
  expect(await paged(w, 'activate')).toMatchObject({ ok: true });
  w.clear();
  return w;
}

describe.skipIf(!sqliteAvailable)('an owner who is not switched is read and written exactly as before', () => {
  it('no root: a whole-list write is the one legacy record, compact; no page or root is written', async () => {
    const w = world();
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(30) })).ok).toBe(true);
    expect(w.commits()).toEqual([]);
    expect(await w.legacy()).toEqual(catalog(30));
    expect(await w.stored(CATALOG_ROOT_RECORD)).toBeNull();
    expect(await readCatalog(w)).toEqual(catalog(30));
  });

  it('a PREPARED (inactive) root: reads and writes still go to the legacy record', async () => {
    const w = world();
    await w.seedLegacy(catalog(20));
    expect((await paged(w, 'prepare')).ok).toBe(true);
    w.clear();
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(21) });
    expect(w.commits()).toEqual([]);
    expect(await readCatalog(w)).toEqual(catalog(21));
  });
});

describe.skipIf(!sqliteAvailable)('the switch: copy → verify → switch', () => {
  it('prepare writes the pages and an inactive root, and leaves the legacy record exactly as stored', async () => {
    const w = world();
    await w.seedLegacy(catalog(200));
    const before = await w.stored('content.catalog');
    expect((await paged(w, 'prepare')).ok).toBe(true);
    expect(await w.stored('content.catalog')).toEqual(before);
    expect((await w.root())!.active).toBe(false);
    expect((await w.root())!.migratedFrom).toMatchObject({ total: 201, legacyRev: before!.rev });
    expect(await paged(w, 'verify')).toMatchObject({ ok: true, total: 201, pagedTotal: 201, orderExact: true, mismatchCount: 0, legacyUnchangedSincePrepare: true });
  });

  it('activate switches only after a passing verify; the assembled read is the legacy list, exactly', async () => {
    const w = await switched(catalog(150));
    expect((await w.root())!.active).toBe(true);
    w.restart();
    expect(JSON.stringify(await readCatalog(w))).toBe(JSON.stringify(catalog(150)));
  });

  it('activate is REFUSED when the legacy record changed after prepare', async () => {
    const w = world();
    await w.seedLegacy(catalog(10));
    await paged(w, 'prepare');
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(11) });
    const out = await paged(w, 'activate');
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/changed after prepare/);
    expect((await w.root())!.active).toBe(false);
    expect(await readCatalog(w)).toEqual(catalog(11));
  });

  it('status and verify on an ACTIVE owner report the legacy record AS STORED, not the pages', async () => {
    const w = await switched(catalog(20));
    await w.op('internal.library.catalogEdit', { upserts: [doc(500)] });
    const s = await paged(w, 'status');
    expect(s).toMatchObject({ paged: true, legacy: { total: 21 }, legacyUnchangedSinceActivate: true });
    const v = await paged(w, 'verify');
    expect(v.ok).toBe(false); // the frozen legacy record lacks the post-switch save — and verify can see that
    expect(v.total).toBe(21);
  });

  it('a switch action is refused while a Library save holds the index, and is in-Worker only, and pages no other owner', async () => {
    const w = world();
    await w.seedLegacy(catalog(5));
    await w.op('internal.coordination.lease', { key: 'content.catalog', holder: 'a-save', ms: 10_000 });
    expect((await w.raw('internal.library.paged', { action: 'prepare', owner: PERSON })).body.code).toBe('catalog_busy');
    expect((await w.raw('internal.library.paged', { action: 'status', owner: '0x' + '22'.repeat(20) })).status).toBe(400);
    expect((await w.raw('internal.library.paged', { action: 'status' }, false)).status).toBe(403);
    expect((await w.raw('internal.library.catalogEdit', { upserts: [doc(1)] }, false)).status).toBe(403);
  });
});

describe.skipIf(!sqliteAvailable)('a switched owner is written as pages', () => {
  it('a whole-list write of one changed entry writes one new page generation and swaps the root — never the legacy record', async () => {
    const w = await switched(catalog(300));
    const legacyBefore = await w.stored('content.catalog');
    const next = catalog(300).map((e) => (e.id === 'doc-17' ? { ...e, version: 2 } : e));
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: next })).ok).toBe(true);
    expect(w.commits()).toEqual(['pages:1', 'root']);
    expect(w.legacyWrites()).toBe(0);
    expect(await w.stored('content.catalog')).toEqual(legacyBefore);
    w.restart();
    expect(await readCatalog(w)).toEqual(next);
  });

  it('a page edit writes one page generation and the root, and the previous generation is collected on the next write', async () => {
    const w = await switched(catalog(300));
    const k = pageOf('doc-5000');
    const g0 = (await w.root())!.pages[k]!.gen;
    expect((await w.op('internal.library.catalogEdit', { upserts: [doc(5000)] })).ok).toBe(true);
    expect(w.commits()).toEqual(['pages:1', 'root']);
    expect(w.log.length).toBeLessThanOrEqual(4); // root read, page read, pages, root swap (no garbage yet)
    expect(await w.stored(`content.catalog.p${k}.g${g0}`)).toMatchObject({ deleted: false }); // kept: the previous generation
    await w.op('internal.library.catalogEdit', { upserts: [doc(5000, { version: 2 })] });
    expect(await w.stored(`content.catalog.p${k}.g${g0}`)).toMatchObject({ deleted: true });
    w.restart();
    expect(await readCatalog(w)).toEqual([...catalog(300), doc(5000, { version: 2 })]);
  });

  it('one edit may name a whole page of rows', async () => {
    const w = await switched(catalog(400));
    const k = pageOf('doc-1');
    const rows = catalog(400).filter((e) => !e.isFolder && pageOf(String(e.id)) === k).map((e) => ({ ...e, version: 2 }));
    expect((await w.op('internal.library.catalogEdit', { upserts: [...rows, ...Array.from({ length: 150 }, (_, i) => doc(10_000 + i))] })).ok).toBe(true);
    expect(((await readCatalog(w)) as unknown[]).length).toBe(551);
  });

  it('a page edit for an owner who is not switched is refused, not written', async () => {
    const w = world();
    await w.seedLegacy(catalog(3));
    const r = await w.raw('internal.library.catalogEdit', { upserts: [doc(9)] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('catalog_not_paged');
    expect(w.commits()).toEqual([]);
  });

  it('the page records cannot be written by naming them — here or at the vault', async () => {
    const w = await switched(catalog(10));
    const root = (await w.root())!;
    for (const rt of [CATALOG_ROOT_RECORD, pageRecordOf(root, root.pages.find((p) => p.gen)!.k)!]) {
      expect((await w.raw('internal.coordination.vaultWrite', { recordType: rt, record: { active: false } })).status).toBe(403);
      expect(await writeVaultRecord(w.vault, PERSON, rt, null)).toMatchObject({ ok: false, error: 'catalog_record_reserved' });
    }
    expect((await w.root())!.active).toBe(true);
  });

  it('a held page is served after the first read; the root and the page read singly come back plain', async () => {
    const w = await switched(catalog(100));
    await readCatalog(w);
    w.clear();
    await readCatalog(w);
    expect(w.log).toEqual([]);
    const root = (await w.op('internal.coordination.vaultRead', { recordType: CATALOG_ROOT_RECORD })).data as CatalogRoot;
    const k = pageOf('doc-4');
    const page = (await w.op('internal.coordination.vaultRead', { recordType: pageRecordOf(root, k)! })).data as Array<{ id: string }>;
    expect(page.find((e) => e.id === 'doc-4')).toEqual(doc(4));
  });
});

describe.skipIf(!sqliteAvailable)('an interrupted write changes nothing a reader can see', () => {
  it('a page write failing mid-plan, at every step: the catalog reads as before, and nothing written is left named', async () => {
    const base = catalog(300);
    // Changes in many pages + a doc→folder move + a folder rename: the hardest plan.
    const next = base.map((e) => (e.id === 'doc-10' ? { ...e, isFolder: true } : e.id === 'f-shelf' ? { ...e, name: 'shelf-renamed' } : typeof e.id === 'string' && Number(String(e.id).slice(4)) % 9 === 0 ? { ...e, version: 7 } : e));
    for (let stop = 0; ; stop++) {
      const w = await switched(base);
      let commits = 0;
      w.fail.when = (tool) => tool === 'catalog_commit' && commits++ === stop;
      const out = await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: next });
      w.fail.when = null;
      w.restart();
      if (out.ok) { expect(await readCatalog(w)).toEqual(next); break; } // the failure point is past the root swap (collect) or beyond the plan
      expect(await readCatalog(w)).toEqual(base);
      expect(stop).toBeLessThan(20);
    }
  });

  it('a doc → folder move interrupted at every vault call: never lost, never doubled', async () => {
    for (const moved of [{ ...doc(10), isFolder: true }, doc(10)]) {
      const start = moved.isFolder ? catalog(80) : catalog(80).map((e) => (e.id === 'doc-10' ? { ...e, isFolder: true } : e));
      for (let stop = 0; stop < 6; stop++) {
        const w = await switched(start);
        let n = 0;
        w.fail.when = () => n++ === stop;
        await w.op('internal.library.catalogEdit', { upserts: [moved] });
        w.fail.when = null;
        w.restart();
        const got = (await readCatalog(w)) as Array<Record<string, unknown>>;
        expect(got.filter((e) => e.id === 'doc-10')).toHaveLength(1);
        expect([JSON.stringify(start), JSON.stringify(start.map((e) => (e.id === 'doc-10' ? moved : e)))]).toContain(JSON.stringify(got));
      }
    }
  });

  it('two interleaved writers: the second root swap is refused (compare-and-set), and the catalog is the first writer’s', async () => {
    const w = await switched(catalog(50));
    const rootBefore = (await w.stored(CATALOG_ROOT_RECORD))!;
    await w.op('internal.library.catalogEdit', { upserts: [doc(700)] });
    // The racer commits a root it planned from the OLD root: the vault refuses it.
    const { commitCatalog } = await import('../../vault/src/catalog-store.js');
    const stale = await commitCatalog(w.vault, PERSON, { op: 'root', data: rootBefore.data, expectRootRev: rootBefore.rev });
    expect(stale).toMatchObject({ ok: false, error: 'catalog_conflict' });
    w.restart();
    expect(await readCatalog(w)).toEqual([...catalog(50), doc(700)]);
  });
});

describe.skipIf(!sqliteAvailable)('a broken paged index is an error, never the frozen legacy record', () => {
  it('a deleted root: reads fail and whole-list writes are refused — the owner is not silently un-paged', async () => {
    const w = await switched(catalog(20));
    await w.op('internal.library.catalogEdit', { upserts: [doc(99)] });
    w.exec(`UPDATE vault_objects SET deleted_at = CURRENT_TIMESTAMP WHERE resource = ?`, 'vault:content.catalog.root');
    w.restart();
    expect((await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' })).ok).toBe(false);
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(1) })).ok).toBe(false);
    expect(w.legacyWrites()).toBe(0);
  });

  it('a root that does not parse: the same', async () => {
    const w = await switched(catalog(20));
    await w.vault.writeGuarded(PERSON, 'vault:content.catalog.root', { format: 'ap.catalog.paged.v2', active: true, pageCount: 32 }, {});
    w.restart();
    expect((await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' })).ok).toBe(false);
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(1) })).ok).toBe(false);
  });
});

describe.skipIf(!sqliteAvailable)('the rollback carries every save since the switch back — and never overwrites a record that moved', () => {
  it('deactivate restores the CURRENT pages into the legacy record, reads it back AS STORED, and only then switches back', async () => {
    const w = await switched(catalog(120));
    await w.op('internal.library.catalogEdit', { upserts: [doc(9000), doc(7, { version: 5 })] });
    const now = await readCatalog(w);
    expect(now).not.toEqual(await w.legacy());
    const out = await paged(w, 'deactivate');
    expect(out).toMatchObject({ ok: true, restored: 122 });
    expect((await w.root())!.active).toBe(false);
    expect(await w.legacy()).toEqual(now);
    w.restart();
    expect(await readCatalog(w)).toEqual(now);
    expect(await paged(w, 'activate')).toMatchObject({ ok: true }); // the pages still equal the restored record
  });

  it('deactivate REFUSES, writing nothing, when the legacy record was written while paged', async () => {
    const w = await switched(catalog(30));
    await w.op('internal.library.catalogEdit', { upserts: [doc(800)] });
    // An out-of-band write that bypassed every guard (raw SQL): the frozen record moved.
    const rec = (await w.stored('content.catalog'))!;
    w.exec(`UPDATE vault_objects SET rev = rev + 1 WHERE resource = ?`, 'vault:content.catalog');
    const before = await w.stored('content.catalog');
    const out = await paged(w, 'deactivate');
    expect(out).toMatchObject({ ok: false, code: 'catalog_legacy_moved' });
    expect(await w.stored('content.catalog')).toEqual(before);
    expect(before!.rev).toBe(rec.rev + 1);
    expect((await w.root())!.active).toBe(true);
  });

  for (const at of ['readback', 'flip'] as const) {
    it(`PROBE: deactivate interrupted AFTER its restore landed (${at}) resumes — it never asks for a manual merge of its own write`, async () => {
      const w = await switched(catalog(40));
      await w.op('internal.library.catalogEdit', { upserts: [doc(4242)] });
      const truth = await readCatalog(w);
      let restored = false;
      w.fail.when = (tool, a) => {
        if (tool === 'catalog_commit' && a.op === 'restore') { restored = true; return false; }
        if (!restored) return false;
        return at === 'readback' ? tool === 'get_catalog_records' : tool === 'catalog_commit' && a.op === 'root';
      };
      expect((await paged(w, 'deactivate')).ok).toBe(false);
      w.fail.when = null;
      w.restart();
      expect(await paged(w, 'status')).toMatchObject({ paged: true, rollbackInProgress: { restoreLanded: true } });
      expect(await paged(w, 'deactivate')).toMatchObject({ ok: true });
      w.restart();
      expect(await readCatalog(w)).toEqual(truth);
      expect(await w.legacy()).toEqual(truth);
      expect((await w.root())!.active).toBe(false);
    });
  }
});

/** Count the vault calls an action makes when nothing fails. */
async function callsOf(make: () => Promise<World>, action: string): Promise<number> {
  const w = await make();
  w.clear();
  expect((await paged(w, action)).ok).toBe(true);
  return w.log.length;
}

describe.skipIf(!sqliteAvailable)('every vault call of the switch, interrupted — before it ran, and after it ran with its answer lost', () => {
  const cases: Array<{ action: string; make: () => Promise<World>; after: (w: World, truth: unknown) => Promise<void> }> = [
    {
      action: 'prepare',
      make: async () => { const w = world(); await w.seedLegacy(catalog(40)); return w; },
      after: async (w, truth) => { expect((await paged(w, 'verify')).ok).toBe(true); expect((await w.root())!.active).toBe(false); expect(await readCatalog(w)).toEqual(truth); },
    },
    {
      action: 'activate',
      make: async () => { const w = world(); await w.seedLegacy(catalog(40)); expect((await paged(w, 'prepare')).ok).toBe(true); return w; },
      after: async (w, truth) => { expect((await w.root())!.active).toBe(true); expect(await readCatalog(w)).toEqual(truth); },
    },
    {
      action: 'deactivate',
      make: async () => { const w = await switched(catalog(40)); await w.op('internal.library.catalogEdit', { upserts: [doc(4242), doc(3, { version: 9 })] }); return w; },
      after: async (w, truth) => { expect((await w.root())!.active).toBe(false); expect(await w.legacy()).toEqual(truth); expect(await readCatalog(w)).toEqual(truth); },
    },
  ];
  for (const c of cases) {
    it(`${c.action}: at every call, the catalog never changes, and running it again finishes it`, async () => {
      const n = await callsOf(c.make, c.action);
      expect(n).toBeGreaterThan(2);
      process.stderr.write(`[calls] ${c.action}: ${n} vault calls\n`);
      for (const mode of ['before', 'after'] as const) {
        for (let stop = 0; stop < n; stop++) {
          const w = await c.make();
          w.restart();
          const truth = await readCatalog(w);
          let calls = 0;
          w.fail.mode = mode;
          w.fail.when = () => calls++ === stop;
          await paged(w, c.action);
          w.fail.when = null;
          w.restart();
          expect(await readCatalog(w), `${c.action} ${mode} call ${stop}`).toEqual(truth);
          const again = await paged(w, c.action);
          expect(again.ok, `${c.action} ${mode} call ${stop}: ${JSON.stringify(again).slice(0, 300)}`).toBe(true);
          w.restart();
          await c.after(w, truth);
        }
      }
    }, 120_000);
  }
});

describe.skipIf(!sqliteAvailable)('an owner split under a pageCount other than 32 (a later rebalance)', () => {
  it('activates, edits, rolls back — and resumes a rollback — with every digest taken under ITS page count', async () => {
    const { buildPagedCatalog, catalogDigest, newGeneration } = await import('../src/catalog-pages.js');
    const { commitCatalog } = await import('../../vault/src/catalog-store.js');
    for (const interruptReadback of [false, true]) {
      const w = world();
      await w.seedLegacy(catalog(70));
      const legacyRev = (await w.stored('content.catalog'))!.rev;
      const built = await buildPagedCatalog(catalog(70), { gen: newGeneration(1), active: false, now: 1, pageCount: 16, migratedFrom: { hash: await catalogDigest(catalog(70), 16), total: 71, legacyRev, at: 1 } });
      expect(await commitCatalog(w.vault, PERSON, { op: 'pages', writes: built.pages.map((p) => ({ recordType: p.recordType, data: p.data })) })).toMatchObject({ ok: true });
      expect(await commitCatalog(w.vault, PERSON, { op: 'root', data: built.root, expectRootRev: -1 })).toMatchObject({ ok: true });
      expect(await paged(w, 'verify')).toMatchObject({ ok: true, legacyUnchangedSincePrepare: true });
      expect(await paged(w, 'activate')).toMatchObject({ ok: true });
      await w.op('internal.library.catalogEdit', { upserts: [doc(4321)] });
      const truth = await readCatalog(w);
      if (interruptReadback) {
        let restored = false;
        w.fail.when = (tool, a) => { if (tool === 'catalog_commit' && a.op === 'restore') { restored = true; return false; } return restored && tool === 'get_catalog_records'; };
        expect((await paged(w, 'deactivate')).ok).toBe(false);
        w.fail.when = null;
      }
      expect(await paged(w, 'deactivate')).toMatchObject({ ok: true });
      expect((await w.root())!.pageCount).toBe(16);
      expect(await w.legacy()).toEqual(truth);
    }
  });
});

describe.skipIf(!sqliteAvailable)('readers racing collection, and the sweep', () => {
  it('a whole-list write decided on a held (stale) root is refused by the vault, and lands as pages on the fresh one', async () => {
    const w = world();
    await w.seedLegacy(catalog(20));
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(21) }); // holds "no root"
    const other = w.second();
    expect((await other('internal.library.paged', { action: 'prepare', owner: PERSON })).ok).toBe(true);
    expect((await other('internal.library.paged', { action: 'activate', owner: PERSON })).ok).toBe(true);
    w.clear();
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(22) })).ok).toBe(true);
    expect(w.legacyWrites()).toBe(1); // tried as legacy on the held root, refused by the vault…
    expect(w.commits()).toContain('root'); // …then written as pages
    expect((await w.stored('content.catalog'))!.rev).toBe(1);
    w.restart();
    expect(await readCatalog(w)).toEqual(catalog(22));
  });

  it('a reader holding an older root whose page was collected by two later commits re-reads the root and succeeds', async () => {
    const w = await switched(catalog(60));
    w.restart();
    await w.op('internal.coordination.vaultRead', { recordType: CATALOG_ROOT_RECORD }); // this object now holds root N (no pages)
    const other = w.second();
    for (const v of [2, 3]) expect((await other('internal.library.catalogEdit', { upserts: [doc(5, { version: v })] })).ok).toBe(true);
    const out = await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' });
    expect(out.ok).toBe(true);
    expect(out.data).toEqual(catalog(60).map((e) => (e.id === 'doc-5' ? doc(5, { version: 3 }) : e)));
  });

  it('the operator sweep and the periodic sweep tombstone page records no root names', async () => {
    const w = await switched(catalog(30));
    const { commitCatalog } = await import('../../vault/src/catalog-store.js');
    const aged = (rt: string) => w.exec(`UPDATE vault_objects SET updated_at = datetime('now', '-10 minutes') WHERE resource = ?`, `vault:${rt}`);
    await commitCatalog(w.vault, PERSON, { op: 'pages', writes: [{ recordType: 'content.catalog.p4.gleak', data: [doc(1)] }] });
    expect(await paged(w, 'sweep')).toMatchObject({ ok: true, swept: [] }); // too young: it may be in flight
    aged('content.catalog.p4.gleak');
    expect(await paged(w, 'sweep')).toMatchObject({ ok: true, swept: ['content.catalog.p4.gleak'] });
    await commitCatalog(w.vault, PERSON, { op: 'pages', writes: [{ recordType: 'content.catalog.p5.gleak', data: [doc(1)] }] });
    aged('content.catalog.p5.gleak');
    for (let i = 0; i < 16 && (await w.stored('content.catalog.p5.gleak'))?.deleted !== true; i++) await w.op('internal.library.catalogEdit', { upserts: [doc(900 + i)] });
    expect(await w.stored('content.catalog.p5.gleak')).toMatchObject({ deleted: true });
  });
});

// ── the record.put cache fix ────────────────────────────────────────────────────────────────────────────────────────
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let signer: CryptoKey;
let jwks: unknown;
let restoreFetch: () => void;
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  signer = kp.privateKey;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }] };
});
beforeEach(() => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    if (url.includes('jwks')) return new Response(JSON.stringify(jwks), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
});
afterEach(() => restoreFetch());
async function session(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const si = `${b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' })))}.${b64url(enc.encode(JSON.stringify({ iss: BROKER_ISS, aud: AUD, sub, iat: now, exp: now + 3600, jti: crypto.randomUUID() })))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, enc.encode(si));
  return `${si}.${b64url(new Uint8Array(sig))}`;
}

describe.skipIf(!sqliteAvailable)('record.put drops what the object held of the record', () => {
  it("the runtime's read after a Home record.put is the new record, not the held one", async () => {
    const w = world();
    await w.vault.write({ owner: PERSON, resource: 'vault:content.artifact.art-1', data: { bytesB64: btoa('old') } });
    expect((await w.op('internal.coordination.vaultRead', { recordType: 'content.artifact.art-1' })).data).toEqual({ bytesB64: btoa('old') });
    const put = await w.raw('record.put', { session: await session(`eip155:${CHAIN}:${PERSON}`), recordType: 'content.artifact.art-1', record: { bytesB64: btoa('new') } }, false);
    expect(put.body).toMatchObject({ ok: true });
    expect((await w.op('internal.coordination.vaultRead', { recordType: 'content.artifact.art-1' })).data).toEqual({ bytesB64: btoa('new') });
  });

  it("a Home record.put of a switched owner's catalog is paged, and the runtime reads it at once", async () => {
    const w = await switched(catalog(50));
    await readCatalog(w);
    const next = [...catalog(50), doc(777)];
    const put = await w.raw('record.put', { session: await session(`eip155:${CHAIN}:${PERSON}`), recordType: 'content.catalog', record: next }, false);
    expect(put.body).toMatchObject({ ok: true });
    expect(w.commits()).toEqual(['pages:1', 'root']);
    expect(await readCatalog(w)).toEqual(next);
  });

  it('record.put may not name a page record', async () => {
    const w = await switched(catalog(5));
    const put = await w.raw('record.put', { session: await session(`eip155:${CHAIN}:${PERSON}`), recordType: CATALOG_ROOT_RECORD, record: { active: false } }, false);
    expect(put.status).toBe(400);
    expect((await w.root())!.active).toBe(true);
  });
});
