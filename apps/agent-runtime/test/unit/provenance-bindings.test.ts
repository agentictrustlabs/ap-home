// Spec 414 A0 — this deployment's bindings of the provenance ports: the vault store answers found / absent /
// refused (never folds a failed read into "none"), and the OTLP exporter sends only where the deployment says.
import { describe, expect, it } from 'vitest';
import { vaultProvenanceStore, otlpHttpExporter } from '../../src/provenance-bindings.js';

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
