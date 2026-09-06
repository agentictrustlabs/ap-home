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
