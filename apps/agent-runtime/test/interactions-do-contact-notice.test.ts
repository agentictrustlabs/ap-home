// A FRIEND NOTICE IN THE PERSON'S OWN INBOX RECORD (spec 401): `internal.contact.notice` keeps who added them and the
// grant that did — one per sender, the newest — beside the envelopes, never as one; it needs no messaging wire. A
// whole-doc inbox write from the messaging library, which does not know the notices, does not drop them.
import { describe, it, expect } from 'vitest';
import { InteractionsDO, type InteractionsDeps, REQUIRED_SCOPES } from '../src/interactions-do.js';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';

const PERSON = '0x1111111111111111111111111111111111111111';
const RUTH = '0x2222222222222222222222222222222222222222';
const MARKER = 'test-internal-marker';
const DIGEST = `0x${'a'.repeat(64)}`;

function world() {
  const records = new Map<string, unknown>();
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const deps: InteractionsDeps = {
    async erc1271() { return true; },
    async vaultTool(_g, tool, args) {
      const a = args as { recordType?: string; data?: unknown };
      if (tool === 'set_vault_record') { records.set(String(a.recordType), structuredClone(a.data)); return ok({ ok: true }); }
      if (tool === 'get_vault_record') return ok({ ok: true, data: records.get(String(a.recordType)) ?? null });
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
  const op = async (name: string, body: Record<string, unknown>, internal = true) =>
    (await (await obj.fetch(new Request(`https://do/interactions/${PERSON}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(internal ? { 'x-ap-internal': MARKER } : {}) }, body: JSON.stringify(body) }))).json()) as Record<string, unknown>;
  return { records, op };
}

describe('a friend notice', () => {
  it('lands in the inbox record beside the envelopes, one per sender', async () => {
    const w = world();
    w.records.set('inbox.data', { version: 1, envelopes: [{ id: 'm1' }] });
    expect((await w.op('internal.contact.notice', { from: RUTH, grantDigest: DIGEST })).ok).toBe(true);
    expect((await w.op('internal.contact.notice', { from: RUTH, grantDigest: DIGEST })).ok).toBe(true);
    const doc = w.records.get('inbox.data') as { envelopes: unknown[]; contactNotices: Array<{ from: string; grantDigest: string }> };
    expect(doc.envelopes).toEqual([{ id: 'm1' }]);
    expect(doc.contactNotices.map((n) => [n.from, n.grantDigest])).toEqual([[RUTH, DIGEST]]);
  });

  it('refuses a notice without a grant, from oneself, or from outside the Worker', async () => {
    const w = world();
    expect((await w.op('internal.contact.notice', { from: RUTH })).ok).toBe(false);
    expect((await w.op('internal.contact.notice', { from: PERSON, grantDigest: DIGEST })).ok).toBe(false);
    const outside = await w.op('internal.contact.notice', { from: RUTH, grantDigest: DIGEST }, false);
    expect(outside.ok).not.toBe(true);
    expect(w.records.get('inbox.data')).toBeUndefined();
  });
});
