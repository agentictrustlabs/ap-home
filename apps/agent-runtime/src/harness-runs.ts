// DURABLE RUNS — spec 350 W3, now the package's (spec 433 W1 step 1, census §2): the checkpoint shape, the turn
// merge, the expiry windows and THE LISTING RULE live in `@agenticprimitives/service-host`; this module binds the
// `RunStore` port to THIS Worker's Durable Object namespace (`A2A_TASKS`) and keeps the `(env, …)` signatures the
// routes call. The binding NAME lives here and only here — the package takes the namespace as a value.
//
// Why the checkpoint is DO-local (ADR-0055's test) and what a resume is NOT are said once, in the package.
import { internalHeaders } from './internal-marker.js';
import { durableObjectRunStore } from '@agenticprimitives/service-host/cloudflare';

export type { HarnessRunCheckpointV1, SuspendedRunV1, SelectedOfferBindingV1 } from '@agenticprimitives/service-host';
export { mergeTurn, isExpired, expiryFor, AWAIT_WINDOW_MS, RUN_TTL_MS, completedStepsOf, canceledRecord, openRunOnThread } from '@agenticprimitives/service-host';

export interface RunStoreEnv {
  A2A_TASKS: DurableObjectNamespace;
  [k: string]: unknown;
}

/** The store over this agent's own DO, in-Worker only (the marker is this Worker's). */
export const runStoreFor = (env: RunStoreEnv) => durableObjectRunStore(env.A2A_TASKS, () => internalHeaders(env as never));
