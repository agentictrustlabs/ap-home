// THE RUN SPEAKS AS IT GOES — spec 370 P2.
//
// A turn takes as long as it takes: a plan, a chain read per party, a verification per step, sometimes a
// userOp. For ten seconds the surface said "One moment." and the person heard a dead line. The loop
// already narrates itself in `RunEvent`s; this module turns each into ONE SENTENCE a screen can show and
// a voice can say — composed by the agent, which knows what a tool is called, never by the client — and
// keeps a short, DO-local, TTL'd list per run that the surface long-polls while the turn is in flight.
//
// What an event is NOT: authority. "Authority confirmed" is a report of a verifier's verdict for one
// step, read from the same event the receipt was built from; nothing consults this list to decide
// anything. It is a rebuild, never a bereavement (ADR-0055): wiping it costs a progress line.
import type { Address } from 'viem';
import type { RunEvent, ToolSpec } from '@agenticprimitives/orchestration';
import { internalHeaders } from './internal-marker.js';

export interface ProgressLineV1 {
  /** Monotonic within the run, assigned by the route as events arrive. */
  seq: number;
  at: number;
  type: RunEvent['type'] | 'ReplyReady';
  stepRef?: string;
  toolId?: string;
  /** One sentence for a screen or a voice. */
  said: string;
  /** The run reached its reply; the surface may stop reading. */
  terminal?: boolean;
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The words for a tool: the capability's plain phrase where one is published ("create organizations"),
 * else the tool's own description. Never the id — "organization.create" is not a thing a voice says.
 */
export function toolWords(tool: ToolSpec | undefined, words: (capabilityId: string) => string | undefined): string {
  if (!tool) return 'the next step';
  const w = tool.capability?.id ? words(tool.capability.id) : undefined;
  return w ?? tool.description ?? tool.id;
}

/** One sentence per loop event. `null` for events that say nothing a person needs mid-turn. */
export function progressLine(e: RunEvent, tools: ReadonlyArray<ToolSpec>, words: (capabilityId: string) => string | undefined): Omit<ProgressLineV1, 'seq' | 'at'> | null {
  const tool = (id: string) => tools.find((t) => t.id === id);
  const w = (id: string) => toolWords(tool(id), words);
  // A tool with no capability exercises no authority: reading, never acting (the loop's own rule).
  const informational = (id: string) => !tool(id)?.capability;
  switch (e.type) {
    case 'PlanCreated': return { type: e.type, said: e.steps === 1 ? 'Working out how — one step.' : `Working out how — ${e.steps} steps.` };
    case 'PlanRefused': return { type: e.type, said: e.replanning ? 'That plan did not fit — trying again.' : 'That plan did not fit.' };
    case 'StepProposed': return { type: e.type, stepRef: e.stepRef, toolId: e.toolId, said: e.risk === 'informational' || informational(e.toolId) ? `Reading ${w(e.toolId)}…` : `Checking your authority to ${w(e.toolId)}…` };
    case 'MandateChecked': return e.decision === 'allow' ? { type: e.type, stepRef: e.stepRef, said: e.afterApproval ? 'Approved and confirmed — going ahead.' : 'Authority confirmed — going ahead.' } : null;
    case 'MandateDenied': return { type: e.type, stepRef: e.stepRef, said: `Refused: ${e.reasons[0]?.message ?? 'the authority does not cover this'}.` };
    case 'ApprovalRequested': return { type: e.type, stepRef: e.stepRef, said: 'This needs an approval — asking.' };
    case 'ApprovalDischarged': return { type: e.type, stepRef: e.stepRef, said: 'Approved.' };
    case 'ApprovalRefused': return { type: e.type, stepRef: e.stepRef, said: `Approval refused${e.reason ? `: ${e.reason}` : ''}.` };
    case 'StepReplayed': return { type: e.type, stepRef: e.stepRef, toolId: e.toolId, said: `${cap(w(e.toolId))}: already done.` };
    case 'ToolInvoked': return { type: e.type, stepRef: e.stepRef, toolId: e.toolId, said: e.ok ? (informational(e.toolId) ? `Read ${w(e.toolId)}.` : `${cap(w(e.toolId))} — done.`) : `${cap(w(e.toolId))} failed.` };
    case 'RunSuspended': return { type: e.type, stepRef: e.stepRef, said: 'I need something from you.' };
    case 'EffectFailed': return { type: e.type, stepRef: e.stepRef, said: 'The act stood, but telling the other side failed.' };
    case 'RunCompleted': return { type: e.type, said: 'Done.', terminal: true };
    case 'RunFailed': return { type: e.type, said: `That did not go through: ${e.error.split(/[:\n]/)[0]}.`, terminal: true };
    case 'StepCompensated': return { type: e.type, stepRef: e.stepRef, said: e.ok ? 'Undone.' : 'Could not undo.' };
    default: return null;
  }
}

// ── The list on the task DO ───────────────────────────────────────────────────────────────────────────

export interface ProgressStoreEnv { A2A_TASKS: DurableObjectNamespace }

async function call(env: ProgressStoreEnv, agent: Address, op: 'progress-append' | 'progress-read', body: unknown): Promise<Record<string, unknown>> {
  const stub = env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));
  const res = await stub.fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, { method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body) }));
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `harness-run/${op} failed (${res.status})`));
  return out;
}

/** Append one line. `asker` is recorded with the first line: reading is gated on it, because a runRef is
 *  a client-chosen string and a progress line names what somebody is doing. */
export async function appendProgress(env: ProgressStoreEnv, addressee: Address, runRef: string, asker: Address, line: ProgressLineV1): Promise<void> {
  await call(env, addressee, 'progress-append', { runRef, asker: asker.toLowerCase(), line });
}

/** The lines after `after`, and whether the run reached its reply. */
export async function readProgress(env: ProgressStoreEnv, addressee: Address, runRef: string, asker: Address, after: number): Promise<{ lines: ProgressLineV1[]; terminal: boolean; known: boolean }> {
  const out = await call(env, addressee, 'progress-read', { runRef, asker: asker.toLowerCase(), after });
  return { lines: (out.lines as ProgressLineV1[] | undefined) ?? [], terminal: !!out.terminal, known: out.known !== false };
}
