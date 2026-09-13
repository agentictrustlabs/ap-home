// Vitest stand-in for `cloudflare:workers` — only what harness-workflow.ts touches. The REAL runtime
// provides these in the Worker; tests exercise the engine-free core (harness-workflow-core.test.ts) and
// merely need the adapter module to be importable.
export class WorkflowEntrypoint<E = unknown, P = unknown> { env!: E; declare protected __p?: P; }
export type WorkflowEvent<P> = { payload: P };
export type WorkflowStep = {
  do: (name: string, cfg: unknown, fn: () => Promise<unknown>) => Promise<unknown>;
  waitForEvent: (name: string, opts: unknown) => Promise<unknown>;
  sleepUntil: (name: string, at: Date) => Promise<void>;
};
// Spec 400 W1c — `@cloudflare/containers` extends these two; the Container class only needs to be importable here
// (runtime-container.ts is exported from index.ts as a DO class; the wake path is tested without it).
export class DurableObject<E = unknown> { constructor(public ctx: unknown, public env: E) {} }
export class WorkerEntrypoint<E = unknown, P = unknown> { env!: E; declare protected __p?: P; }
