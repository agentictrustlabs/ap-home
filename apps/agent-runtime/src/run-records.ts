// The run record's home — spec 370 P6: the agent's own task object, a week, listed without mandates. The store is the
// package's (`@agenticprimitives/service-host`, spec 433 W1 step 2); this module keeps the `(env, …)` signatures the routes
// call and rides the operator index (spec 406 W1) beside the record — a failure there costs a row, never the record.
import type { Address } from 'viem';
import type { RunRecordV1 } from '@agenticprimitives/orchestration';
import type { RunRecordListingV1 } from '@agenticprimitives/service-host';
import { indexRun, indexRuns, type OpsEnv } from './ops-index.js';
import { runStoreFor, type RunStoreEnv } from './harness-runs.js';

export interface RecordStoreEnv extends OpsEnv, RunStoreEnv {}

export async function putRecord(env: RecordStoreEnv, addressee: Address, record: RunRecordV1): Promise<void> {
  await runStoreFor(env).putRecord(addressee, record);
  await indexRun(env, addressee, record);
}
/** Spec 406 W1 — rebuild the operator index from the agent's records (the index is a projection; this is its proof). */
export async function rebuildOpsIndex(env: RecordStoreEnv, addressee: Address): Promise<{ records: number; indexed: number }> {
  // One call per agent: the listing with each step's ids and verdicts (never args or results) — all the row reads.
  const rows = (await runStoreFor(env).listRecords(addressee, { full: true })).records as unknown as RunRecordV1[];
  const indexed = await indexRuns(env, addressee, rows);
  return { records: rows.length, indexed };
}
export async function getRecord(env: RecordStoreEnv, addressee: Address, runRef: string): Promise<RunRecordV1 | null> {
  return runStoreFor(env).getRecord(addressee, runRef);
}
/** The listing: every record minus its mandates and events, with step and receipt counts (+ skill / tool facets). */
export async function listRecords(env: RecordStoreEnv, addressee: Address): Promise<Array<Omit<RunRecordV1, 'presented' | 'events' | 'steps' | 'receipts'> & { steps: number; receipts: number }>> {
  return (await runStoreFor(env).listRecords(addressee)).records as unknown as Array<Omit<RunRecordV1, 'presented' | 'events' | 'steps' | 'receipts'> & { steps: number; receipts: number }>;
}
export type { RunRecordListingV1 };
