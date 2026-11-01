// THE LIBRARY INDEX'S SEAM IN THE PRINCIPAL'S OBJECT (catalog-pages.ts, interactions-do.ts). Every reader and writer of
// `content.catalog` passes through the DO's vault client, so an owner switched to pages is read and written as pages
// with none of them knowing — and an owner who is not switched is read and written exactly as before. The switch itself
// (`internal.library.paged`) copies, verifies and only then flips; the rollback carries every later save back.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { InteractionsDO, type InteractionsDeps, REQUIRED_SCOPES } from '../src/interactions-do.js';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';
import { compactCatalog, expandCatalog } from '../src/catalog-codec.js';
import { CATALOG_ROOT_RECORD, activeCatalogRoot, catalogPageRecord, pageOf, type CatalogRoot } from '../src/catalog-pages.js';

const PERSON = '0x1111111111111111111111111111111111111111';
const MARKER = 'test-internal-marker';
const CHAIN = 84532;
const BROKER_ISS = 'https://home.example.test';
const AUD = 'demo-sso';
const KID = 'paged-key-1';

const doc = (i: number, extra: Record<string, unknown> = {}) => ({ id: `doc-${i}`, kind: 'md', name: `n${i}.md`, folder: 'shelf', size: i, version: 1, createdAt: 1000 + i, ...(i % 4 === 0 ? { releases: [{ releaseId: `0xr${i}`, version: '1.0.0', signature: '0x51' + 'ab'.repeat(400) + i.toString(16).padStart(8, '0'), signed: true }] } : {}), ...extra });
const folder = { id: 'f-shelf', kind: 'md', name: 'shelf', folder: '', isFolder: true };
const catalog = (n: number) => [folder, ...Array.from({ length: n }, (_, i) => doc(i))];

function world() {
  const records = new Map<string, unknown>();
  const log: Array<{ op: 'read' | 'write'; recordType: string }> = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const deps: InteractionsDeps = {
    async erc1271() { return true; },
    async vaultTool(_g, tool, args) {
      const a = args as { recordType?: string; recordTypes?: string[]; data?: unknown; pagedRestore?: boolean };
      if (tool === 'set_vault_record') {
        const rt = String(a.recordType);
        // The vault service's own guard: a paged owner's legacy record is written only by the rollback.
        if (rt === 'content.catalog' && a.pagedRestore !== true && activeCatalogRoot(records.get(CATALOG_ROOT_RECORD))) return ok({ ok: false, error: 'catalog_paged' });
        log.push({ op: 'write', recordType: rt });
        records.set(rt, structuredClone(a.data));
        return ok({ ok: true });
      }
      if (tool === 'get_vault_record') {
        const rt = String(a.recordType);
        log.push({ op: 'read', recordType: rt });
        // The vault expands a compact catalog for its callers.
        const data = records.get(rt) ?? null;
        return ok({ ok: true, data: rt === 'content.catalog' ? expandCatalog(structuredClone(data)) : structuredClone(data) });
      }
      if (tool === 'get_vault_records') {
        const out: Record<string, unknown> = {};
        for (const rt of a.recordTypes ?? []) { log.push({ op: 'read', recordType: rt }); out[rt] = structuredClone(records.get(rt) ?? null); }
        return ok({ ok: true, records: out });
      }
      return ok({ ok: true, records: [] });
    },
  };
  const cav = buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources: [...REQUIRED_SCOPES, 'vault:content.*'], ops: ['read', 'write'] }] as never);
  const grant = { delegator: PERSON, delegate: '0x4444444444444444444444444444444444444444', authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: cav.enforcer, terms: cav.terms, args: '0x' }], salt: '0', signature: `0x${'ab'.repeat(65)}` };
  const m = new Map<string, unknown>([['state', { grant }]]);
  const obj = new InteractionsDO(
    { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string | string[]) { for (const x of [k].flat()) m.delete(x); }, async list() { return new Map(); } } } as never,
    { RPC_URL: 'https://rpc.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.test', A2A_INTERNAL_MARKER: MARKER, BROKER_ISS, BROKER_JWKS_URL: `${BROKER_ISS}/.well-known/jwks.json`, DEMO_SSO_AUD: AUD } as never,
    deps,
  );
  const raw = async (name: string, body: Record<string, unknown>, internal = true) => {
    const res = await obj.fetch(new Request(`https://do/interactions/${PERSON}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(internal ? { 'x-ap-internal': MARKER } : {}) }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const op = async (name: string, body: Record<string, unknown>) => (await raw(name, body)).body;
  const writes = () => log.filter((l) => l.op === 'write').map((l) => l.recordType);
  const reads = () => log.filter((l) => l.op === 'read').map((l) => l.recordType);
  const clear = () => { log.length = 0; };
  const root = () => records.get(CATALOG_ROOT_RECORD) as CatalogRoot | undefined;
  return { records, log, op, raw, writes, reads, clear, root };
}
type World = ReturnType<typeof world>;
const paged = (w: World, action: string) => w.op('internal.library.paged', { action, owner: PERSON });
const readCatalog = async (w: World) => (await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' })).data;

/** Prepare, verify and activate an owner whose legacy record is `list`. */
async function switched(list: unknown[]): Promise<World> {
  const w = world();
  w.records.set('content.catalog', compactCatalog(list));
  expect((await paged(w, 'prepare')).ok).toBe(true);
  expect((await paged(w, 'activate')).ok).toBe(true);
  w.clear();
  return w;
}

describe('an owner who is not switched is read and written exactly as before', () => {
  it('no root: a whole-list write is the one legacy record, compact; no page or root is written', async () => {
    const w = world();
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(30) })).ok).toBe(true);
    expect(w.writes()).toEqual(['content.catalog']);
    expect(expandCatalog(w.records.get('content.catalog'))).toEqual(catalog(30));
    expect(await readCatalog(w)).toEqual(catalog(30));
  });

  it('a PREPARED (inactive) root: reads and writes still go to the legacy record', async () => {
    const w = world();
    w.records.set('content.catalog', catalog(20));
    expect((await paged(w, 'prepare')).ok).toBe(true);
    w.clear();
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(21) });
    expect(w.writes()).toEqual(['content.catalog']);
    expect(await readCatalog(w)).toEqual(catalog(21));
  });
});

describe('the switch: copy → verify → switch', () => {
  it('prepare writes every page and an inactive root, and leaves the legacy record exactly as it was', async () => {
    const w = world();
    const legacy = compactCatalog(catalog(200));
    w.records.set('content.catalog', legacy);
    const before = JSON.stringify(legacy);
    const out = await paged(w, 'prepare');
    expect(out.ok).toBe(true);
    expect(w.writes()).toEqual([...Array.from({ length: 32 }, (_, k) => catalogPageRecord(k)), CATALOG_ROOT_RECORD]);
    expect(JSON.stringify(w.records.get('content.catalog'))).toBe(before);
    expect(w.root()!.active).toBe(false);
    expect(w.root()!.migratedFrom?.total).toBe(201);
    const v = await paged(w, 'verify');
    expect(v).toMatchObject({ ok: true, total: 201, pagedTotal: 201, orderExact: true, mismatchCount: 0, legacyUnchangedSincePrepare: true });
  });

  it('activate switches only after a passing verify; the assembled read is the legacy list, exactly', async () => {
    const w = await switched(catalog(150));
    expect(w.root()!.active).toBe(true);
    expect(JSON.stringify(await readCatalog(w))).toBe(JSON.stringify(catalog(150)));
    expect(w.reads().filter((r) => r === 'content.catalog')).toHaveLength(0);
  });

  it('activate is REFUSED when the legacy record changed after prepare', async () => {
    const w = world();
    w.records.set('content.catalog', catalog(10));
    await paged(w, 'prepare');
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: catalog(11) }); // a save in between
    const out = await paged(w, 'activate');
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/changed after prepare/);
    expect(w.root()!.active).toBe(false);
    expect(await readCatalog(w)).toEqual(catalog(11));
  });

  it('activate is REFUSED when the pages do not match (a page altered after prepare)', async () => {
    const w = world();
    w.records.set('content.catalog', catalog(40));
    await paged(w, 'prepare');
    const k = pageOf('doc-3');
    const rows = expandCatalog(w.records.get(catalogPageRecord(k))) as Array<Record<string, unknown>>;
    w.records.set(catalogPageRecord(k), rows.map((r) => (r.id === 'doc-3' ? { ...r, name: 'tampered' } : r)));
    const out = await paged(w, 'activate');
    expect(out.ok).toBe(false);
    expect(w.root()!.active).toBe(false);
  });

  it('a switch action is refused while a Library save holds the index', async () => {
    const w = world();
    w.records.set('content.catalog', catalog(5));
    await w.op('internal.coordination.lease', { key: 'content.catalog', holder: 'a-save', ms: 10_000 });
    const r = await w.raw('internal.library.paged', { action: 'prepare', owner: PERSON });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('catalog_busy');
  });

  it('pages another owner never', async () => {
    const w = world();
    const r = await w.raw('internal.library.paged', { action: 'status', owner: '0x' + '22'.repeat(20) });
    expect(r.status).toBe(400);
  });

  it('is in-Worker only', async () => {
    const w = world();
    expect((await w.raw('internal.library.paged', { action: 'status' }, false)).status).toBe(403);
    expect((await w.raw('internal.library.catalogEdit', { upserts: [doc(1)] }, false)).status).toBe(403);
  });
});

describe('a switched owner is written as pages', () => {
  it('a whole-list write of one changed entry writes that page and the root — never the legacy record', async () => {
    const w = await switched(catalog(300));
    const legacyBefore = JSON.stringify(w.records.get('content.catalog'));
    const next = catalog(300).map((e) => (e.id === 'doc-17' ? { ...e, version: 2 } : e));
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: next })).ok).toBe(true);
    expect(w.writes()).toEqual([catalogPageRecord(pageOf('doc-17')), CATALOG_ROOT_RECORD]);
    expect(JSON.stringify(w.records.get('content.catalog'))).toBe(legacyBefore);
    expect(await readCatalog(w)).toEqual(next);
  });

  it('a page edit (the runtime save) reads root + one page fresh and writes one page + the root', async () => {
    const w = await switched(catalog(300));
    const out = await w.op('internal.library.catalogEdit', { upserts: [doc(5000)] });
    expect(out.ok).toBe(true);
    expect(w.reads()).toEqual([CATALOG_ROOT_RECORD, catalogPageRecord(pageOf('doc-5000'))]);
    expect(w.writes()).toEqual([catalogPageRecord(pageOf('doc-5000')), CATALOG_ROOT_RECORD]);
    expect(await readCatalog(w)).toEqual([...catalog(300), doc(5000)]);
  });

  it('a page edit for an owner who is not switched is refused, not written', async () => {
    const w = world();
    w.records.set('content.catalog', catalog(3));
    const r = await w.raw('internal.library.catalogEdit', { upserts: [doc(9)] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('catalog_not_paged');
    expect(w.writes()).toEqual([]);
  });

  it('the page records cannot be written by naming them', async () => {
    const w = await switched(catalog(10));
    for (const rt of [CATALOG_ROOT_RECORD, catalogPageRecord(3)]) {
      const r = await w.raw('internal.coordination.vaultWrite', { recordType: rt, record: { format: 'ap.catalog.paged.v1', active: false } });
      expect(r.status).toBe(403);
    }
    expect(w.root()!.active).toBe(true);
  });

  it('the runtime read is served from held pages after the first read', async () => {
    const w = await switched(catalog(100));
    w.clear();
    await readCatalog(w);
    await readCatalog(w);
    expect(w.reads()).toEqual([]); // prepare/activate held what they wrote
  });

  it('a page and the root read singly come back plain (the runtime save reads them this way)', async () => {
    const w = await switched(catalog(100));
    const k = pageOf('doc-4');
    const page = (await w.op('internal.coordination.vaultRead', { recordType: catalogPageRecord(k) })).data as Array<{ id: string }>;
    expect(page.find((e) => e.id === 'doc-4')).toEqual(doc(4));
    expect(((await w.op('internal.coordination.vaultRead', { recordType: CATALOG_ROOT_RECORD })).data as CatalogRoot).active).toBe(true);
  });
});

describe('the rollback carries every save since the switch back', () => {
  it('deactivate writes the CURRENT pages into the legacy record, verifies it, and only then switches back', async () => {
    const w = await switched(catalog(120));
    await w.op('internal.library.catalogEdit', { upserts: [doc(9000), doc(7, { version: 5 })] });
    const now = await readCatalog(w);
    w.clear();
    const out = await paged(w, 'deactivate');
    expect(out.ok).toBe(true);
    expect(w.writes()).toEqual(['content.catalog', CATALOG_ROOT_RECORD]);
    expect(w.root()!.active).toBe(false);
    expect(expandCatalog(w.records.get('content.catalog'))).toEqual(now);
    expect(await readCatalog(w)).toEqual(now);
    // …and the owner can be switched again straight away: the pages still equal the restored record.
    expect((await paged(w, 'activate')).ok).toBe(true);
  });
});

// ── the record.put cache fix ────────────────────────────────────────────────────────────────────────────────────────
// The Home writes a person's Library records through `record.put`, which does not pass through `writeDoc`; the object
// kept serving its minute-old copy of the record to the runtime's next read.
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

describe('record.put drops what the object held of the record', () => {
  it("the runtime's read after a Home record.put is the new record, not the held one", async () => {
    const w = world();
    w.records.set('content.artifact.art-1', { bytesB64: btoa('old') });
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
    expect(w.writes()).toEqual([catalogPageRecord(pageOf('doc-777')), CATALOG_ROOT_RECORD]);
    expect(await readCatalog(w)).toEqual(next);
  });

  it('record.put may not name a page record', async () => {
    const w = await switched(catalog(5));
    const put = await w.raw('record.put', { session: await session(`eip155:${CHAIN}:${PERSON}`), recordType: CATALOG_ROOT_RECORD, record: { active: false } }, false);
    expect(put.status).toBe(400);
    expect(w.root()!.active).toBe(true);
  });
});
