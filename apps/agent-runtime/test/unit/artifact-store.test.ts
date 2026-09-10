// Spec 391 — the artifact store over the vault door: what leaves the record, where it goes, what comes back.
import { describe, expect, it } from 'vitest';
import type { RunResult } from '@agenticprimitives/orchestration';
import { artifactStoreFor, recordFormOf, rehydrateExecuted, offloadThreshold } from '../../src/artifact-store.js';

const AGENT = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11';
const big = { resources: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, title: `T${i}`, description: 'x'.repeat(400) })) };
const result: RunResult = { outcome: 'completed', runRef: 'run-9', plan: { steps: [{ toolId: 'catalog.resource.search', args: {}, id: 's0' }, { toolId: 'catalog.resource.get', args: { id: { $ref: 's0.resources.0.id' } }, id: 's1' }] }, steps: [{ step: { toolId: 'catalog.resource.search', args: {}, id: 's0' }, ok: true, result: big, stepRef: 's0' }], receipts: [] } as never;

function doors() {
  const vault = new Map<string, unknown>();
  return { vault, writeSubjectRecord: async (subject: string, recordType: string, record: unknown) => { vault.set(`${subject}|${recordType}`, record); return { ok: true }; }, readSubjectRecord: async (subject: string, recordType: string) => vault.get(`${subject}|${recordType}`) ?? null };
}

describe('artifact store', () => {
  it('no write door ⇒ no store, nothing offloaded, the result unchanged', async () => {
    expect(artifactStoreFor({})).toBeNull();
    expect(await recordFormOf({}, {}, AGENT, 'run-9', result)).toEqual({ result, offloaded: [] });
    expect(offloadThreshold({})).toBe(8_000);
    expect(offloadThreshold({ OFFLOAD_THRESHOLD_CHARS: '2000' })).toBe(2_000);
  });
  it('the record form writes the artifact under the agent and the run key and keeps a reference; a resume restores it for the $ref', async () => {
    const d = doors();
    const kept = await recordFormOf({}, d, AGENT, 'run-9', result);
    expect(kept.offloaded).toEqual([{ stepRef: 's0', toolId: 'catalog.resource.search', bytes: expect.any(Number), recordType: 'run.artifact:run-9:s0', ok: true }]);
    expect(d.vault.has(`${AGENT}|run.artifact:run-9:s0`)).toBe(true);
    expect((kept.result.steps[0]!.result as { $artifact: string }).$artifact).toBe('ap.artifact-ref.v1');
    const executed = { plan: result.plan, completed: [{ stepRef: 's0', result: kept.result.steps[0]!.result }] };
    const back = await rehydrateExecuted(d, executed);
    expect(back.completed[0]!.result).toEqual(big);
  });
  it('a refused write is reported and the body stays', async () => {
    const kept = await recordFormOf({}, { writeSubjectRecord: async () => ({ ok: false, error: 'record_scope_denied' }) }, AGENT, 'run-9', result);
    expect(kept.offloaded[0]).toMatchObject({ ok: false, error: 'record_scope_denied' });
    expect(kept.result.steps[0]!.result).toEqual(big);
  });
});
