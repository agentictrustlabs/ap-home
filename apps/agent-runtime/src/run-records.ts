// The run record's home — spec 370 P6: the agent's own task object, a week, listed without mandates.
import type { Address } from 'viem';
import type { RunRecordV1 } from '@agenticprimitives/orchestration';
import { internalHeaders } from './internal-marker.js';

export interface RecordStoreEnv { A2A_TASKS: DurableObjectNamespace }

async function call(env: RecordStoreEnv, agent: Address, op: 'record-put' | 'record-get' | 'record-list', body: unknown): Promise<Record<string, unknown>> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, { method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body) }));
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `harness-run/${op} failed (${res.status})`));
  return out;
}

export async function putRecord(env: RecordStoreEnv, addressee: Address, record: RunRecordV1): Promise<void> {
  await call(env, addressee, 'record-put', { record });
}
export async function getRecord(env: RecordStoreEnv, addressee: Address, runRef: string): Promise<RunRecordV1 | null> {
  return ((await call(env, addressee, 'record-get', { runRef })).record as RunRecordV1 | undefined) ?? null;
}
/** The listing: every record minus its mandates and events, with step and receipt counts. */
export async function listRecords(env: RecordStoreEnv, addressee: Address): Promise<Array<Omit<RunRecordV1, 'presented' | 'events' | 'steps' | 'receipts'> & { steps: number; receipts: number }>> {
  return ((await call(env, addressee, 'record-list', {})).records as never[] | undefined) ?? [];
}
