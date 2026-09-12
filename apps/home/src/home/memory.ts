// THREE STORES, NEVER ONE LABEL — spec 398 §6.1 (I07 / APUX-035). Personal facts, workspace knowledge and run context
// are three different things, owned by three different vaults, and the Home shows them as three views:
//   PERSONAL  — remembered choices (385), standing instructions (394), learned preferences (358 W5) · the person's vault
//               · list · correct · forget (a receipt that cited the fact keeps its citation — the retained-evidence
//               exception is SAID)
//   WORKSPACE — endeavor context (334), topic snapshots (340), Library releases · the org's / service's vault
//               · list · who can see it · publication state
//   RUN       — run.artifact, run.provenance, checkpoints (350 W3) · the acting agent's vault · ephemeral by default;
//               promotion to the Library is an ACT with a receipt, never a drag
// A personal fact never becomes workspace knowledge without a sharing act that leaves a record (T14). Pure: it takes
// what the clients return and sorts it; it fetches nothing and decides nothing about authority.
import type { RememberedChoice, StandingInstruction, ParkedRun, RunRecordRow } from './ask';
import type { TodayArtifact } from './today';
import type { EndeavorRow } from '../lib/work-client';
import { stateOf, type ProjectedRunStateV1 } from './run-state';
import { lifecycleState } from '../components/portal/work/labels';

export type MemoryStore = 'personal' | 'workspace' | 'run';

export interface MemoryItem {
  id: string;
  store: MemoryStore;
  /** What kind of record: the vault record key's family, in words. */
  kind: string;
  title: string;
  detail?: string;
  at?: number;
  /** The vault the record lives in — whose. */
  owner: string;
  /** What the person may do with it here. */
  actions: Array<'forget' | 'correct' | 'open' | 'promote'>;
  state?: ProjectedRunStateV1;
  native?: string;
  /** Who can see it (workspace) / publication state, when the record says. */
  visibility?: string;
  /** For forget/correct: the scope the clients take. */
  ref?: Record<string, string>;
}

export interface MemoryInputs {
  /** The person's own agent (lowercased). */
  self: string;
  /** The vault the WORKSPACE and RUN views are about (the org's / service's, or the person's own). */
  workspace: string;
  confirmations: ReadonlyArray<RememberedChoice>;
  instructions: ReadonlyArray<StandingInstruction>;
  endeavors: ReadonlyArray<EndeavorRow>;
  artifacts: ReadonlyArray<TodayArtifact & { releases?: number; grants?: number }>;
  records: ReadonlyArray<RunRecordRow>;
  checkpoints: ReadonlyArray<ParkedRun & { state?: string }>;
}

export interface MemoryViews {
  personal: MemoryItem[];
  workspace: MemoryItem[];
  run: MemoryItem[];
  /** What each store does NOT show yet, said in the view rather than left blank. */
  absent: Record<MemoryStore, string[]>;
}

export function assembleMemory(i: MemoryInputs): MemoryViews {
  const personal: MemoryItem[] = [
    ...i.confirmations.map((c) => ({
      id: `confirmation:${c.word}:${c.capability}:${c.arg}`, store: 'personal' as const, kind: 'remembered choice',
      title: `“${c.word}” means ${c.label ?? c.agent.slice(0, 10) + '…'}`, detail: `when ${c.capabilityWords} asks for ${c.arg}`,
      at: Date.parse(c.at), owner: i.self, actions: ['forget' as const, 'correct' as const],
      ref: { word: c.word, capability: c.capability, arg: c.arg },
    })),
    ...i.instructions.map((s) => ({
      id: `instruction:${s.context}:${s.capability}:${s.arg}`, store: 'personal' as const, kind: 'standing instruction',
      title: `${s.arg} = ${s.label ?? s.value}`, detail: `${s.capabilityWords}${s.context && s.context !== i.self ? ` · in ${s.context.slice(0, 10)}…` : ' · everywhere'}`,
      at: Date.parse(s.at), owner: i.self, actions: ['forget' as const, 'correct' as const],
      ref: { context: s.context, capability: s.capability, arg: s.arg },
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const workspace: MemoryItem[] = [
    ...i.endeavors.map((e) => ({
      id: `endeavor:${e.endeavorId}`, store: 'workspace' as const, kind: 'endeavor context', title: e.title,
      ...(e.updatedAt ? { at: Date.parse(e.updatedAt) } : {}), owner: i.workspace, actions: ['open' as const],
      state: lifecycleState(e.lifecycle), native: e.lifecycle, visibility: 'members of this workspace',
    })),
    ...i.artifacts.map((a) => ({
      id: `artifact:${a.id}`, store: 'workspace' as const, kind: a.releases ? 'Library release' : 'Library artifact', title: a.name,
      detail: [a.kind, a.version && a.version > 1 ? `v${a.version}` : undefined].filter(Boolean).join(' · '), at: a.createdAt, owner: i.workspace, actions: ['open' as const],
      visibility: a.releases ? `published · ${a.releases} release${a.releases === 1 ? '' : 's'}` : a.grants ? `shared with ${a.grants}` : 'owner only',
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const run: MemoryItem[] = [
    ...i.checkpoints.map((r) => ({
      id: `checkpoint:${r.runRef}`, store: 'run' as const, kind: 'checkpoint', title: r.message, detail: 'an unfinished ask — what you said, granted and answered; gone when it finishes or expires',
      at: r.updatedAt, owner: i.workspace, actions: ['open' as const],
      state: r.state ? { state: r.state as ProjectedRunStateV1['state'], effectUncertain: false } : stateOf({ kind: 'suspended', awaiting: undefined, expired: false }),
    })),
    ...i.records.map((r) => ({
      id: `record:${r.runRef}`, store: 'run' as const, kind: r.export?.ok ? 'run.provenance (in the vault)' : 'run record', title: r.intent?.goal ?? r.runRef,
      detail: `${r.steps} step${r.steps === 1 ? '' : 's'} · ${r.receipts} receipt${r.receipts === 1 ? '' : 's'}${r.export?.ok ? '' : r.export?.error ? ` · provenance not exported: ${r.export.error}` : ' · provenance on the serving object only'}`,
      at: r.at, owner: i.workspace, actions: ['open' as const, 'promote' as const],
      state: stateOf({ kind: 'run', outcome: r.outcome as never, ...(r.canceled ? { canceled: true } : {}) }), native: r.outcome,
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  return {
    personal, workspace, run,
    absent: {
      personal: ['learned preferences (358 W5) — the agent does not yet keep any'],
      workspace: ['topic snapshots (340 ContextSnapshot) — not listed here yet; each is on its topic'],
      run: ['run.artifact bodies — listed on each run\'s inspector; promotion to the Library is not yet an act (398 §6.1)'],
    },
  };
}
