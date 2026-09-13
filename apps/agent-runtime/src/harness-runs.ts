// DURABLE RUNS — spec 350 W3. A run that stopped to ask a person outlives the tab it was asked in.
//
// Through W2 the run lived in the browser: the surface held the intent, the mandate wire and every answer,
// and re-sent all of it each turn. That works and it is honest — a resume is a full re-run through every
// gate — but it makes a suspended run a property of one open page. Close it and the authority you granted
// is gone with the run that asked for it; nobody else can see that a payment is waiting on a signature;
// and the mandate sits in browser memory between turns for no reason.
//
// So the checkpoint lives in the ASKED AGENT'S OWN DurableObject, keyed by runRef.
//
// WHY DO-LOCAL IS RIGHT HERE (ADR-0055's test: if this DO were wiped, is the loss a rebuild or a
// bereavement?). A suspended run is a REBUILD: you ask again and grant again. Nothing here is the record
// of anything — the receipts are the evidence and go to the audit sink, the mandate is re-mintable by the
// person who minted it, and the agent an ask creates is on chain the moment it exists. A checkpoint is
// the serving plane's memory of an unfinished conversation, which is exactly what DO storage is for.
//
// WHAT A RESUME IS NOT. It is not a continuation past a gate. The stored intent is re-planned, the stored
// mandate is re-verified (on chain: signature, revocation, intent binding, limits), the ladder is
// re-applied and the approval re-checked — every turn, exactly as the first. The checkpoint holds only
// what the person already gave us; it grants nothing and it decides nothing.
import type { SuppliedInputV1, Plan, StepReceipt, CommitmentRefV1, RunRecordV1 } from '@agenticprimitives/orchestration';
import type { SelectedOfferBindingV1 } from './engagement-campaign.js';
import type { Address } from 'viem';
import type { DelegationWireV1 } from '@agenticprimitives/a2a';
import { internalHeaders } from './internal-marker.js';

/** One unfinished ask. Small on purpose: what the person said, what they granted, what they answered. */
export interface HarnessRunCheckpointV1 {
  runRef: string;
  /** The sentence. An ask is ONE thing — a different sentence is a different ask and a different intent
   *  digest, so it may not inherit this run's mandate. */
  message: string;
  /** The FULL intent when the run was entered with one (a durable/supplied-plan run). The mandate binds
   *  the digest of THIS object — rebuilding `{ goal }` from the message alone changes the digest and
   *  every mandate mismatches, which is how the first refs-only attempt denied its own valid mandate. */
  intent?: { goal: string; constraints?: Record<string, unknown>; context?: Record<string, unknown> };
  /** The realm the ask was addressed to. */
  addressee: Address;
  /** WHO asked. Only they may resume: a run carries their session's authority and their answers. */
  asker: Address;
  /** THE KEYRING — every mandate this run has been granted, not just the last one (spec 350 W3).
   *
   *  It was one wire, replaced each turn, and that is what made the 4-payment fan-out cost 13 turns: a
   *  plan that needs a mandate PER ITEM could only ever hold the newest, so each turn settled exactly one
   *  payee and reported authority-required for the rest. Accumulating them here means turn N sends only
   *  the NEW mandate and the run advances with every key it has been given.
   *
   *  Holding a key is not holding authority. Every wire here is re-verified on every turn — signature,
   *  revocation, intent binding, limits — and the loop still judges each step under exactly ONE selected
   *  mandate (ADR-0013). A keyring makes the run rememberable, never more permitted. */
  presented: DelegationWireV1[];
  /** Everything answered so far, by stepRef. */
  supplied: SuppliedInputV1[];
  /** Spec 361 I4 — the caller-supplied plan, when the run was entered deterministically. Utterance-class
   *  content, which is exactly why it lives HERE (DO-local, TTL'd) and never in engine params (§6). */
  plan?: { steps: Array<{ toolId: string; args: Record<string, unknown>; id?: string }> };
  /** What the run is waiting for, for a surface that lists pending work. `expiresAt` (spec 370 P1) is
   *  when waiting stops being resumable: a signature or confirmation is asked against a mandate minted
   *  for minutes, and a run past its window reads EXPIRED rather than pending forever. */
  awaiting?: { kind: 'data' | 'signature' | 'confirmation' | 'commitment' | 'authority'; prompt: string; stepRef: string; expiresAt?: number;
    /** Spec 374 — when `kind` is `commitment`: what another agent owes this run, and where it waits. */
    commitment?: CommitmentRefV1;
    /** Spec 385 — when this prompt was an AMBIGUITY choice, the scope it confirms (word + capability + arg),
     *  so the resume that answers it can be remembered as a scoped preference. Display/memory only. */
    scope?: { word: string; capability: string; arg: string } };
  /**
   * Spec 370 P1 — WHAT RAN. The plan the run was admitted with (fan-out already expanded) and the steps
   * that completed, each with what it returned and the receipt that recorded it. A resume hands these
   * back to the loop, which REPLAYS them — no planner call, no invoker, no verifier for a step that is
   * not being attempted (spec 362 §0.1, gate 4) — and judges the remaining steps as if for the first time.
   * Evidence of what happened; never permission for what has not. DO-local and TTL'd like the rest.
   */
  executed?: { plan: Plan; completed: Array<{ stepRef: string; result?: unknown; receipt?: StepReceipt }> };
  /** Spec 370 P5 — this run was started by a TRIGGER of the agent's playbook, not by a person: the asker
   *  is the agent, nothing was presented, and a steward finishes it. Display and audit; no gate reads it. */
  trigger?: { id: string; playbookDigest: string };
  /** Spec 372 N1 — this run was started by an OUTSIDE runtime on the standard A2A surface, calling as the
   *  agent named: it presented no mandate and cannot sign one, so a steward finishes it. Display and audit;
   *  no gate reads it — the asker is `asker`, verified at the door, and that is what `claimableBy` reads. */
  outsider?: { agent: Address; surface: 'a2a-standard' | 'subject-ask' };
  /** Spec 374 — this run is a ROUTED ACT another agent's run is waiting on: when it finishes, the outcome
   *  is DELIVERED to the creditor's agent, which resumes the run that asked. The correlation is the
   *  creditor's (spec 366 R2), echoed so the creditor can match it to exactly one suspended step. */
  routedFrom?: { creditor: Address; correlation: { operationId: string; runRef: string; stepRef: string } };
  /** Spec 374 W2 — where each ROUTED step of this run waits at the subject's agent, so a resume carries the
   *  asker's mandate or answer to THAT run as a continuation rather than asking the subject afresh. */
  routedAt?: Record<string, { agent: Address; name?: string; runRef: string }>;
  /** Spec 370 P1 tail — when this run stops being resumable, whatever it waits for. An authority request
   *  waits for a mandate minted for THIS request, minutes not days; 240 of them listed as "unfinished"
   *  was a day's asks a person had simply walked away from. Absent on older rows ⇒ `updatedAt`-based. */
  expiresAt?: number;
  /** Set when the run is a WORK ITEM nobody has picked up: `asker` is the principal rather than a person,
   *  and any steward who can mint the mandate may claim it (`endeavor-authority-steps.claimableBy`). */
  openToStewards?: boolean;
  /** The plan step this run exists to satisfy. When it completes, the step's evidence is its RECEIPT. */
  origin?: { endeavorId: string; stepId: string; principal: Address;
    /** Spec 382 — the signed commitment this run fulfils and the adopted plan hash it was compiled from. */
    commitmentRef?: string; planHash?: string;
    /** Spec 384 W3 — the campaign's selection: the provider the step is handed to and the offer the mandate must
     *  name. Shapes the plan (`bindSelectedOffer`); no verifier reads it — the verifier reads the mandate. */
    engagement?: SelectedOfferBindingV1 };
  /** spec 362 — WHICH ENGINE advances this run. `client` (the flyout re-drives it — the default) or
   *  `workflow` (a Cloudflare Workflows instance owns it). ONE executor per run, never a fallback pair:
   *  the other entry path refuses to advance a run it does not own, because two engines discovering the
   *  same operation is how a payment happens twice. */
  executor?: 'client' | 'workflow';
  /** Spec 400 W2 (B3) — the THREAD this run belongs to (a conversation id: a DM, or a topic's `conv_topic-…`), when a
   *  message on that thread opened it. What a later mention on the same thread finds the run by: a run parked for
   *  DATA there takes the mention as its answer instead of a new run opening beside it. */
  thread?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunStoreEnv {
  A2A_TASKS: DurableObjectNamespace;
  [k: string]: unknown;
}

const stubFor = (env: RunStoreEnv, agent: Address) => env.A2A_TASKS.get(env.A2A_TASKS.idFromName(agent.toLowerCase()));

async function call(env: RunStoreEnv, agent: Address, op: 'save' | 'load' | 'drop' | 'list', body: unknown): Promise<Record<string, unknown>> {
  const res = await stubFor(env, agent).fetch(new Request(`https://a2a-task-do/internal/harness-run/${op}`, {
    method: 'POST', headers: internalHeaders(env as never), body: JSON.stringify(body),
  }));
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!res.ok || out.ok === false) throw new Error(String(out.error ?? `harness-run/${op} failed (${res.status})`));
  return out;
}

export async function saveRun(env: RunStoreEnv, checkpoint: HarnessRunCheckpointV1): Promise<void> {
  await call(env, checkpoint.addressee, 'save', { checkpoint });
}

export async function loadRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<HarnessRunCheckpointV1 | null> {
  const out = await call(env, addressee, 'load', { runRef });
  return (out.checkpoint as HarnessRunCheckpointV1 | undefined) ?? null;
}

/** One unfinished run as a LISTING shows it — everything but the keyring. A list says that something is
 *  waiting and what it waits for; it never hands out the mandates, which only a resume does and only to
 *  whoever may resume. */
export type SuspendedRunV1 = Omit<HarnessRunCheckpointV1, 'presented'>;

/**
 * The unfinished runs on this agent. A checkpoint has always recorded what a run is `awaiting` and
 * whether it is `openToStewards`; nothing could read that back, so a payment waiting on a signature was
 * invisible to everyone — including the person who owed it (this module's own opening complaint).
 *
 * Returns ALL of them. Who may see which is the caller's decision, made where the session is known.
 */
export async function listRuns(env: RunStoreEnv, addressee: Address): Promise<SuspendedRunV1[]> {
  const out = await call(env, addressee, 'list', {});
  return (out.runs as SuspendedRunV1[] | undefined) ?? [];
}

/** Spec 400 W2 (B3) — THE OPEN RUN ON A THREAD: the newest unexpired run on `thread` that waits for DATA (a question the
 *  next message can answer). A run waiting on a signature, a commitment or authority is not resumable by words, and a
 *  mention leaves it where it is (the reply to that mention opens no run either — the run is what is waiting). */
export function openRunOnThread(runs: readonly SuspendedRunV1[], thread: string, now = Date.now()): SuspendedRunV1 | null {
  return runs
    .filter((r) => r.thread === thread && r.awaiting?.kind === 'data' && !isExpired(r, now))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/** A run that reached a terminal outcome leaves nothing behind: done is done, and a denial is terminal
 *  (ADR-0013) — keeping it invites a caller to "try the resume again" as though refusal were weather. */
export async function dropRun(env: RunStoreEnv, addressee: Address, runRef: string): Promise<void> {
  await call(env, addressee, 'drop', { runRef });
}

/** Merge a turn's inputs over the checkpoint. The stored answers come FIRST so a resend of the same
 *  stepRef adds rather than replaces — a person who signs twice has signed twice, and the port picks the
 *  signature that verifies. */
/** A wire's identity WITHIN one run: delegator + delegate + salt. The salt is fresh per delegation, so
 *  this separates two mandates that differ only in a caveat (one payee vs another) while collapsing the
 *  same wire re-sent by a client that has not noticed the server remembers it. Not a security check —
 *  it dedups a list; every wire is verified on chain regardless. */
const wireKey = (w: DelegationWireV1): string =>
  `${String(w.delegator).toLowerCase()}:${String(w.delegate).toLowerCase()}:${String(w.salt)}`;

/** Normalise the many shapes a turn may present (nothing / one / a keyring) into a list. */
const asList = (p: DelegationWireV1 | DelegationWireV1[] | null | undefined): DelegationWireV1[] =>
  p == null ? [] : Array.isArray(p) ? p : [p];

export function mergeTurn(
  stored: HarnessRunCheckpointV1 | null,
  turn: { message?: string; presented?: DelegationWireV1 | DelegationWireV1[] | null; supplied?: SuppliedInputV1[] },
): { message: string; presented: DelegationWireV1[]; supplied: SuppliedInputV1[] } | { error: string } {
  const message = (turn.message ?? stored?.message ?? '').trim();
  if (!message) return { error: 'this run has no question and none was given' };
  if (stored && turn.message && turn.message.trim() !== stored.message) {
    // The mandate is bound to the intent digest, so a changed sentence would be denied a step later with
    // `intent-mismatch`. Saying it here names the actual mistake instead of a hash comparison.
    return { error: 'this run was started for a different question — ask it as a new one rather than changing this one mid-way' };
  }
  // THE KEYRING GROWS, NEWEST FIRST. Replacing (the old `turn.presented ?? stored.presented`) discarded
  // every mandate but the newest, which is why a fan-out cost a turn per payee. Accumulating keeps the
  // earlier keys for the items they were granted for.
  //
  // ORDER CARRIES THE RE-GRANT RULE. This turn's mandates go in FRONT, so when a person re-grants for the
  // same purpose (the first expired, say) the fresh wire is the one selection reaches first — the
  // behaviour the single-slot version had — while the older keys remain available for OTHER items. A
  // re-grant has a fresh salt, so it is a distinct key and never dedups away the one it supersedes.
  const keyring: DelegationWireV1[] = [];
  const seen = new Set<string>();
  for (const w of [...asList(turn.presented), ...asList(stored?.presented)]) {
    const k = wireKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    keyring.push(w);
  }
  return {
    message,
    presented: keyring,
    supplied: [...(stored?.supplied ?? []), ...(turn.supplied ?? [])],
  };
}

/** How long a wait stays resumable (spec 370 P1). A signature or a confirmation answers a mandate minted
 *  for the request — minutes, not days — so half an hour is generous; a data question (which Nathan?)
 *  has no mandate yet and may wait two hours — after that the person has moved on, and asking again costs less than a list of ghosts. */
export const AWAIT_WINDOW_MS: Record<'data' | 'signature' | 'confirmation' | 'commitment' | 'authority', number> = { data: 2 * 3600_000, signature: 30 * 60_000, confirmation: 30 * 60_000, authority: 30 * 60_000,
  // Spec 374 — a commitment waits on ANOTHER agent's steward, on that agent's clock; a day is the outer bound here.
  commitment: 24 * 3600_000 };

/** Past its window: resumable no longer. Absent window ⇒ the day prune is the only expiry. */
export function isExpired(cp: Pick<HarnessRunCheckpointV1, 'awaiting' | 'expiresAt' | 'updatedAt'>, now = Date.now()): boolean {
  if (typeof cp.awaiting?.expiresAt === 'number') return cp.awaiting.expiresAt < now;
  if (typeof cp.expiresAt === 'number') return cp.expiresAt < now;
  // Older rows carry no window. A data question keeps the day; anything else — an authority request, a
  // signature — is stale after the same half hour a new row would get.
  if (cp.awaiting?.kind === 'data') return false;
  return typeof cp.updatedAt === 'number' && now - cp.updatedAt > AWAIT_WINDOW_MS.signature;
}

/** The window a run keeps from the moment it stopped: the prompt's own, else the authority window. */
export function expiryFor(awaiting: HarnessRunCheckpointV1['awaiting'] | undefined, now = Date.now()): number {
  return now + (awaiting ? AWAIT_WINDOW_MS[awaiting.kind] : AWAIT_WINDOW_MS.signature);
}

/** The completed steps of a run result, as a checkpoint records them — successful, named, with their
 *  receipt. A failed or suspended step is not "done" and is not replayed. */
export function completedStepsOf(result: { steps: ReadonlyArray<{ ok: boolean; stepRef?: string; result?: unknown }>; receipts: ReadonlyArray<StepReceipt> }): HarnessRunCheckpointV1['executed'] extends infer E ? E extends { completed: infer C } ? C : never : never {
  return result.steps
    .filter((o) => o.ok && o.stepRef)
    .map((o) => {
      const receipt = result.receipts.find((r) => r.stepRef === o.stepRef);
      return { stepRef: o.stepRef!, ...(o.result !== undefined ? { result: o.result } : {}), ...(receipt ? { receipt } : {}) };
    });
}

/**
 * Spec 398 §5.3 — THE RECORD OF A CANCELED RUN. The turn's record is kept and MARKED (never rewritten as
 * failed: nothing went wrong); a record that never landed (the turn writes it fire-and-forget) is synthesised
 * from the checkpoint — what ran, what it left, nothing invented. `afterSteps` is how many steps had completed:
 * the sentence a surface shows is "stopped after step N; steps 1–N happened".
 */
export function canceledRecord(
  existing: RunRecordV1 | null,
  stored: Pick<HarnessRunCheckpointV1, 'runRef' | 'message' | 'intent' | 'executed'>,
  by: { at: number; by: Address; note?: string },
): RunRecordV1 & { canceled: NonNullable<RunRecordV1['canceled']> } {
  const completed = stored.executed?.completed ?? [];
  const base: RunRecordV1 = existing ?? {
    type: 'ap.run-record.v1', runRef: stored.runRef, at: by.at,
    intent: stored.intent ?? { goal: stored.message },
    plan: stored.executed?.plan ?? { steps: [] },
    steps: completed.map((x) => ({ stepRef: x.stepRef, toolId: x.receipt?.toolId ?? '', args: {}, ok: true, ...(x.result !== undefined ? { result: x.result } : {}) })),
    receipts: completed.flatMap((x) => (x.receipt ? [x.receipt] : [])),
    events: [], outcome: 'suspended',
  };
  const note = by.note?.trim() ? by.note.trim().slice(0, 280) : undefined;
  return { ...base, canceled: { at: by.at, by: by.by, afterSteps: completed.length, ...(note ? { note } : {}) } };
}
