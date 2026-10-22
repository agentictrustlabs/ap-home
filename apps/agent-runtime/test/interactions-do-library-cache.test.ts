// THE LIBRARY'S RECORDS, SERVED FROM THE PRINCIPAL'S OBJECT. Every Library act read the catalog (and a document's record)
// from the vault — ~1 s a round trip, twice a save. Every write of them passes through this object's `writeDoc`, so the
// runtime's internal read is answered from what was last written or read here, for a minute. A failed write drops the
// entry; records outside the Library are always read from the vault.
import { describe, it, expect } from 'vitest';
import { InteractionsDO, type InteractionsDeps, REQUIRED_SCOPES } from '../src/interactions-do.js';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';

const PERSON = '0x1111111111111111111111111111111111111111';
const MARKER = 'test-internal-marker';

function world() {
  const records = new Map<string, unknown>();
  const reads: string[] = [];
  const fail = { write: false };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const deps: InteractionsDeps = {
    async erc1271() { return true; },
    async vaultTool(_g, tool, args) {
      const a = args as { recordType?: string; data?: unknown };
      if (tool === 'set_vault_record') {
        if (fail.write) return new Response(JSON.stringify({ error: 'vault refused' }), { status: 500 });
        records.set(String(a.recordType), a.data);
        return ok({ ok: true });
      }
      if (tool === 'get_vault_record') { reads.push(String(a.recordType)); return ok({ ok: true, data: records.get(String(a.recordType)) ?? null }); }
      return ok({ ok: true, records: [] });
    },
  };
  const cav = buildVaultRecordScopeCaveat([{ server: 'demo-mcp', resources: [...REQUIRED_SCOPES], ops: ['read', 'write'] }] as never);
  const grant = { delegator: PERSON, delegate: '0x4444444444444444444444444444444444444444', authority: `0x${'0'.repeat(64)}`, caveats: [{ enforcer: cav.enforcer, terms: cav.terms, args: '0x' }], salt: '0', signature: `0x${'ab'.repeat(65)}` };
  const m = new Map<string, unknown>([['state', { grant }]]);
  const obj = new InteractionsDO(
    { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string) { m.delete(k); } } } as never,
    { RPC_URL: 'https://rpc.test', CHAIN_ID: '84532', MCP_URL: 'https://mcp.test', A2A_INTERNAL_MARKER: MARKER } as never,
    deps,
  );
  const op = async (name: string, body: Record<string, unknown>) =>
    (await (await obj.fetch(new Request(`https://do/interactions/${PERSON}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': MARKER }, body: JSON.stringify(body) }))).json()) as Record<string, unknown>;
  return { records, reads, fail, op };
}

describe("the person's Library records, served from their object", () => {
  it('answers a read after a write without asking the vault', async () => {
    const w = world();
    expect((await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: [{ id: 'a' }] })).ok).toBe(true);
    const r = await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' });
    expect(r.data).toEqual([{ id: 'a' }]);
    expect(w.reads.filter((x) => x === 'content.catalog')).toHaveLength(0);
  });

  it('reads the vault once, then answers from memory', async () => {
    const w = world();
    w.records.set('content.artifact.art-1', { bytesB64: 'eA==' });
    await w.op('internal.coordination.vaultRead', { recordType: 'content.artifact.art-1' });
    await w.op('internal.coordination.vaultRead', { recordType: 'content.artifact.art-1' });
    expect(w.reads.filter((x) => x === 'content.artifact.art-1')).toHaveLength(1);
  });

  it('drops the entry when a write fails, so the next read goes to the vault', async () => {
    const w = world();
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: [{ id: 'a' }] });
    w.fail.write = true;
    await w.op('internal.coordination.vaultWrite', { recordType: 'content.catalog', record: [{ id: 'b' }] });
    w.fail.write = false;
    const r = await w.op('internal.coordination.vaultRead', { recordType: 'content.catalog' });
    expect(w.reads.filter((x) => x === 'content.catalog')).toHaveLength(1);
    expect(r.data).toEqual([{ id: 'a' }]);
  });

  it('never caches a record outside the Library', async () => {
    const w = world();
    w.records.set('conversation.recent', { turns: [] });
    await w.op('internal.coordination.vaultRead', { recordType: 'conversation.recent' });
    await w.op('internal.coordination.vaultRead', { recordType: 'conversation.recent' });
    expect(w.reads.filter((x) => x === 'conversation.recent')).toHaveLength(2);
  });
});
