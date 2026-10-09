// PROGRESS LINES — spec 370 P2, now the package's (spec 433 W1 step 1): `ProgressLineV1`, `progressLine` and `toolWords`
// come from `@agenticprimitives/service-host`; this module binds the store to THIS Worker's DO namespace and keeps the
// `(env, …)` signatures the ask route and the progress route call.
import type { Address } from 'viem';
import type { ProgressLineV1 } from '@agenticprimitives/service-host';
import { runStoreFor, type RunStoreEnv } from './harness-runs.js';

export type { ProgressLineV1 } from '@agenticprimitives/service-host';
export { toolWords, progressLine } from '@agenticprimitives/service-host';

export type ProgressStoreEnv = RunStoreEnv;

/** Append one line. `asker` is recorded with the first line: reading is gated on it, because a runRef is a
 *  client-chosen string and a progress line names what somebody is doing. */
export async function appendProgress(env: ProgressStoreEnv, addressee: Address, runRef: string, asker: Address, line: ProgressLineV1): Promise<void> {
  await runStoreFor(env).appendProgress(addressee, runRef, asker.toLowerCase() as Address, line);
}

/** The lines after `after`, and whether the run reached its reply. */
export async function readProgress(env: ProgressStoreEnv, addressee: Address, runRef: string, asker: Address, after: number): Promise<{ lines: ProgressLineV1[]; terminal: boolean; known: boolean }> {
  const out = await runStoreFor(env).readProgress(addressee, runRef, asker.toLowerCase() as Address, after);
  return { lines: out.lines, terminal: out.terminal, known: out.known };
}
