// Spec 414 A0 — this deployment's bindings of the provenance ports: the vault store answers found / absent /
// refused (never folds a failed read into "none"), and the OTLP exporter sends only where the deployment says.
import { describe, expect, it } from 'vitest';
import { vaultProvenanceStore, otlpHttpExporter, readCarriedProvenance } from '../../src/provenance-bindings.js';

const REF = { agent: '0xAbC0000000000000000000000000000000000001', key: 'run.provenance:run-1' };

describe('vaultProvenanceStore', () => {
  it('is no store at all without a door', () => {
    expect(vaultProvenanceStore({})).toBeUndefined();
  });
  it('puts through the agent\'s own write door, lower-cased, and reports a refusal as an error', async () => {
    const seen: string[] = [];
    const s = vaultProvenanceStore({ writeSubjectRecord: async (subject, key) => { seen.push(`${subject}|${key}`); return subject.endsWith('1') ? { ok: true } : { ok: false }; } })!;
    expect(s.binding).toBe('mcp-vault');
    expect(await s.put(REF, { a: 1 })).toEqual({ ok: true });
    expect(seen).toEqual([`${REF.agent.toLowerCase()}|run.provenance:run-1`]);
    expect(await s.put({ ...REF, agent: '0x2' }, {})).toEqual({ ok: false, error: 'vault write refused' });
  });
  it('reads found, absent, and refused — a thrown read is refused, not absent (ADR-0013)', async () => {
    const found = vaultProvenanceStore({ readSubjectRecord: async () => ({ '@context': {} }) })!;
    expect(await found.get(REF)).toEqual({ status: 'found', document: { '@context': {} } });
    const absent = vaultProvenanceStore({ readSubjectRecord: async () => null })!;
    expect(await absent.get(REF)).toEqual({ status: 'absent' });
    const broken = vaultProvenanceStore({ readSubjectRecord: async () => { throw new Error('vault_key_unauthorized'); } })!;
    expect(await broken.get(REF)).toEqual({ status: 'refused', reason: 'vault_key_unauthorized' });
    const writeOnly = vaultProvenanceStore({ writeSubjectRecord: async () => ({ ok: true }) })!;
    expect(await writeOnly.get(REF)).toEqual({ status: 'refused', reason: 'no vault read door' });
  });
});

describe('otlpHttpExporter', () => {
  it('sends nowhere when no endpoint is named, and says so without an error', async () => {
    let calls = 0;
    const x = otlpHttpExporter({}, (async () => { calls++; return new Response('{}'); }) as never);
    expect(await x.exportTraces([])).toEqual({ sent: false });
    expect(calls).toBe(0);
  });
  it('reports a collector refusal as an error', async () => {
    const x = otlpHttpExporter({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example/v1/traces' }, (async () => new Response('no', { status: 503 })) as never);
    expect(await x.exportTraces([])).toEqual({ sent: false, error: 'collector answered 503' });
  });
});

describe('readCarriedProvenance — a carried record is read only by its agent or its steward', () => {
  const store = vaultProvenanceStore({ readSubjectRecord: async () => ({ '@context': {}, id: 'urn:ap:prov:bundle:run-1' }) });
  let reads = 0;
  const counted = vaultProvenanceStore({ readSubjectRecord: async () => { reads++; return { id: 'x' }; } });
  const oversee = async (caller: string, agent: string) => caller === agent || caller === '0xsteward';
  it('serves the agent itself and its steward', async () => {
    expect((await readCarriedProvenance(store, '0xalice', '0xalice', 'run.provenance:run-1', oversee)).status).toBe('found');
    expect((await readCarriedProvenance(store, '0xsteward', '0xalice', 'run.provenance:run-1', oversee)).status).toBe('found');
  });
  it('the twin: any other signed-in caller is forbidden, and the store is never read for them', async () => {
    reads = 0;
    expect(await readCarriedProvenance(counted, '0xmallory', '0xalice', 'run.provenance:run-1', oversee)).toEqual({ status: 'forbidden' });
    expect(reads).toBe(0);
  });
  it('a standing check that throws is a refusal to serve, not a pass', async () => {
    expect(await readCarriedProvenance(store, '0xalice', '0xalice', 'k', async () => { throw new Error('rpc down'); })).toEqual({ status: 'forbidden' });
  });
});

describe('spec 414 §6 — the vault binding passes the same conformance suite as the directory store', () => {
  it('C1–C6 over the vault doors; a reader the vault refuses is refused, never served empty', async () => {
    const { runProvenanceConformance } = await import('@agenticprimitives/provenance-node/conform');
    const vault = new Map<string, unknown>();
    const door = { writeSubjectRecord: async (s: string, k: string, rec: unknown) => { vault.set(`${s}|${k}`, structuredClone(rec)); return { ok: true }; }, readSubjectRecord: async (s: string, k: string) => vault.get(`${s}|${k}`) ?? null };
    const stranger = vaultProvenanceStore({ readSubjectRecord: async () => { throw new Error('vault_key_unauthorized'); } })!;
    const r = await runProvenanceConformance(vaultProvenanceStore(door)!, { stranger, target: 'mcp-vault (in-memory door)' });
    expect(r.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([]);
  }, 60_000);
});
