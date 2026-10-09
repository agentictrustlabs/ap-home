// DURABLE RUNS — spec 350 W3, now the package's (spec 433 W1 step 1, census §2): the checkpoint shape, the turn
// merge, the expiry windows and THE LISTING RULE live in `@agenticprimitives/service-host`; this module binds the
// `RunStore` port to THIS Worker's Durable Object namespace (`A2A_TASKS`) and keeps the `(env, …)` signatures the
// routes call. The binding NAME lives here and only here — the package takes the namespace as a value.
//
// Why the checkpoint is DO-local (ADR-0055's test) and what a resume is NOT are said once, in the package.
import type { Address } from 'viem';
import { internalHeaders } from './internal-marker.js';
import { durableObjectRunStore } from '@agenticprimitives/service-host/cloudflare';
import type { HarnessRunCheckpointV1, SuspendedRunV1 } from '@agenticprimitives/service-host';

export type { HarnessRunCheckpointV1, SuspendedRunV1, SelectedOfferBindingV1 } from '@agenticprimitives/service-host';
export { mergeTurn, isExpired, expiryFor, AWAIT_WINDOW_MS, RUN_TTL_MS, completedStepsOf, canceledRecord, openRunOnThread } from '@agenticprimitives/service-host';

export interface RunStoreEnv {
  A2A_TASKS: DurableObjectNamespace;
  [k: string]: unknown;
}

/** The store over this agent's own DO, in-Worker only (the marker is this Worker's). */
export const runStoreFor = (env: RunStoreEnv) => durableObjectRunStore(env.A2A_TASKS, () => internalHeaders(env as never));

export async function saveRun(env: RunStoreEnv, checkpoint: HarnessRunCheckpointV1): Promise<void> {
  await runStoreFor(env).save(checkpoint);
}

export async function loadRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<HarnessRunCheckpointV1 | null> {
  return runStoreFor(env).load(addressee, runRef);
}

/** The unfinished runs on this agent — ALL of them, keyring stripped. Who may see which is the caller's decision. */
export async function listRuns(env: RunStoreEnv, addressee: Address): Promise<SuspendedRunV1[]> {
  return runStoreFor(env).list(addressee);
}

export async function dropRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<void> {
  await runStoreFor(env).drop(addressee, runRef);
}
