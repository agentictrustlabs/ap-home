// THE ARTIFACT STORE, BOUND TO THE VAULT DOOR — spec 391's app half. The Ring-0 rule (`orchestration/artifacts.ts`)
// says WHEN a result leaves the run's record and WHAT stands in for it; this file says WHERE it goes: the
// acting agent's own vault, through the same effect-write door the provenance record uses (ADR-0055 — the
// artifact is the agent's record, never a DO's), under the `vault:run.artifact:*` scope of that agent's grant.
//
// A door that refuses (a grant signed before this scope existed answers `record_scope_denied`) leaves the
// result in the record whole and the refusal on the report — the run is never the poorer for a store that
// could not write, and nothing is dropped silently.
import { offloadRunResult, rehydrateObservations, OFFLOAD_THRESHOLD_CHARS, type ArtifactStore, type OffloadReport, type RunResult, type Plan, type RunArtifactRecordV1 } from '@agenticprimitives/orchestration';

export interface ArtifactDoors {
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
}

export interface ArtifactEnv { OFFLOAD_THRESHOLD_CHARS?: string }

/** The threshold this deployment offloads at (a setting, recorded on the run). */
export function offloadThreshold(env: ArtifactEnv): number {
  const n = Number(env.OFFLOAD_THRESHOLD_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : OFFLOAD_THRESHOLD_CHARS;
}

/** The store over the doors, or null when this deployment has no write door (a test harness, say). */
export function artifactStoreFor(doors: ArtifactDoors): ArtifactStore | null {
  if (!doors.writeSubjectRecord) return null;
  const write = doors.writeSubjectRecord;
  const read = doors.readSubjectRecord;
  return {
    async put(record, agent) {
      const out = await write(agent.toLowerCase(), `run.artifact:${record.runRef}:${record.stepRef}`, record);
      return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'the vault refused the artifact' };
    },
    async get(ref) {
      if (!read) return null;
      const rec = (await read(ref.agent.toLowerCase(), ref.recordType).catch(() => null)) as RunArtifactRecordV1 | null;
      return rec && rec.type === 'ap.run-artifact.v1' ? rec : null;
    },
  };
}

/** The RECORD FORM of a run's result: large results offloaded to the acting agent's vault, references in
 *  their place. The turn's own reply keeps the full result; this is what the record and the checkpoint keep. */
export async function recordFormOf(env: ArtifactEnv, doors: ArtifactDoors, agent: string, runRef: string, result: RunResult): Promise<{ result: RunResult; offloaded: OffloadReport[] }> {
  const store = artifactStoreFor(doors);
  if (!store) return { result, offloaded: [] };
  return offloadRunResult(result, { runRef, agent, store, threshold: offloadThreshold(env) });
}

/** A checkpoint's completed steps with the bodies a remaining step's `$ref` needs restored from the vault. */
export async function rehydrateExecuted<E extends { plan: Plan; completed: Array<{ stepRef: string; result?: unknown }> }>(doors: ArtifactDoors, executed: E): Promise<E> {
  const store = artifactStoreFor(doors);
  if (!store) return executed;
  const { completed } = await rehydrateObservations(executed.completed, executed.plan, store);
  return { ...executed, completed };
}
