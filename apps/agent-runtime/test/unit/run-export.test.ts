// THE RUN, EXPORTED — the app's half (spec 381): provenance through the vault door, spans to a collector
// only when one is named, a declared retention, and a firewall failure that refuses instead of leaking.
import { describe, expect, it } from 'vitest';
import type { RunRecordV1 } from '@agenticprimitives/orchestration';
import { exportRun, recordRetention, firewalledSpans, DEFAULT_RECORD_RETENTION_DAYS } from '../../src/run-export.js';

const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const record: RunRecordV1 = {
  type: 'ap.run-record.v1', runRef: 'run-x', at: 1_788_920_800_000,
  intent: { goal: 'pay nathan.treasury 1 usdc', context: { addressee: ALICE, asker: ALICE } },
  plan: { steps: [{ toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, id: 's0' }] },
  steps: [{ stepRef: 's0', toolId: 'treasury.payment.execute', args: { payee: 'nathan.treasury', usdc: '1' }, ok: true, result: { txHash: '0x' + 'cd'.repeat(32) } }],
  receipts: [{ runRef: 'run-x', stepRef: 's0', index: 0, toolId: 'treasury.payment.execute', capability: { id: 'treasury.payment.execute', action: 'execute' }, risk: 'high', status: 'completed', startedAt: 1_788_920_700, completedAt: 1_788_920_790, authority: { presentedRef: '0x' + '11'.repeat(32), decision: { decision: 'allow', reasons: [] }, afterApproval: true }, inputDigest: 'json:{"payee":"nathan.treasury","usdc":"1"}' } as never],
  events: [], outcome: 'completed',
};

describe('exportRun', () => {
  it('writes the provenance through the agent\'s own door and sends nothing when no collector is named', async () => {
    const writes: Array<{ subject: string; recordType: string; record: unknown }> = [];
    let fetched = 0;
    const r = await exportRun({}, { writeSubjectRecord: async (subject, recordType, rec) => { writes.push({ subject, recordType, record: rec }); return { ok: true }; }, fetch: (async () => { fetched++; return new Response('{}'); }) as never }, ALICE, record);
    expect(r.provenance).toEqual({ written: true, recordType: 'run.provenance:run-x' });
    expect(writes[0]!.subject).toBe(ALICE);
    // Spec 389 — what lands is the GRAPH: a JSON-LD bundle under the published context, the run and its step
    // as PROV activities, the transaction as a generated entity, the mandate as a used delegation.
    const prov = writes[0]!.record as { '@context': unknown; id: string; type: string[]; graph: Array<Record<string, unknown>> };
    expect(prov['@context']).toBeTruthy();
    expect(prov.id).toBe('urn:ap:prov:bundle:run-x');
    expect(prov.type).toContain('ExecutionTraceBundle');
    const step = prov.graph.find((n) => n['id'] === 'urn:ap:prov:act:run-x:s0')!;
    expect(step['usedDelegation']).toBe(`urn:ap:prov:mandate:0x${'11'.repeat(32)}`);
    expect(step['authorityDecision']).toBe('allow');
    expect(step['generated']).toContain(`urn:ap:prov:tx:0x${'cd'.repeat(32)}`);
    expect(prov.graph.find((n) => n['id'] === 'urn:ap:prov:act:run-x')!['wasAssociatedWith']).toBe(`urn:ap:prov:runtime:urn:ap:agent:${ALICE}`);
    expect(JSON.stringify(prov)).not.toContain('nathan');
    expect(JSON.stringify(prov)).not.toContain('json:');
    expect(r.spans).toEqual({ count: 2, sent: false });
    expect(fetched).toBe(0);
  });
  it('posts an OTLP body to the named collector with its headers; a refused write is reported, not thrown', async () => {
    let got: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const r = await exportRun({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/v1/traces', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc, x-dataset=runs' }, {
      writeSubjectRecord: async () => ({ ok: false, error: 'record_scope_denied' }),
      fetch: (async (url: string, init: RequestInit) => { got = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }; return new Response('{}', { status: 200 }); }) as never,
    }, ALICE, record);
    expect(r.provenance).toEqual({ written: false, recordType: 'run.provenance:run-x', error: 'record_scope_denied' });
    expect(r.spans).toEqual({ count: 2, sent: true });
    expect(got!.url).toBe('https://collector.example/v1/traces');
    expect(got!.headers['x-api-key']).toBe('abc');
    expect(got!.headers['x-dataset']).toBe('runs');
    const body = got!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name)).toEqual(['invoke_agent', 'execute_tool treasury.payment.execute']);
    expect(JSON.stringify(body)).not.toContain('nathan');
  });
  it('declares the retention, from the deployment or the default', () => {
    expect(recordRetention({})).toEqual({ doDays: DEFAULT_RECORD_RETENTION_DAYS, vaultRecord: 'run.provenance:<runRef>' });
    expect(recordRetention({ HARNESS_RECORD_RETENTION_DAYS: '30' }).doDays).toBe(30);
    expect(recordRetention({ HARNESS_RECORD_RETENTION_DAYS: 'x' }).doDays).toBe(7);
  });
  it('names agents the way the public KB does when the deployment names its chain', async () => {
    const { provenanceGraphOf } = await import('../../src/run-export.js');
    const doc = await provenanceGraphOf({ CHAIN_ID: '34348' }, ALICE, record) as { wasAttributedTo: string };
    expect(doc.wasAttributedTo).toBe(`urn:ap:agent:eip155:34348:${ALICE}`);
  });
  it('spec 390 — the ids on the spans are the ids in the graph, both ways', async () => {
    const { provenanceGraphOf } = await import('../../src/run-export.js');
    const doc = await provenanceGraphOf({}, ALICE, record) as { id: string; graph: Array<Record<string, unknown>> };
    const spans = await firewalledSpans(record);
    for (const sp of spans) {
      const node = doc.graph.find((n) => n['id'] === sp.attributes['ap.prov.activity.id']);
      expect(node, `graph node for ${sp.name}`).toBeTruthy();
      expect(node!['spanId']).toBe(sp.spanId);
      expect(node!['traceId']).toBe(sp.traceId);
      expect(sp.attributes['ap.prov.bundle.id']).toBe(doc.id);
    }
  });
  it('the served spans are the firewalled ones', async () => {
    const spans = await firewalledSpans(record);
    expect(spans[1]!.attributes['ap.receipt.digest']).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(spans)).not.toContain('nathan');
  });
});
