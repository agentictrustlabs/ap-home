// THE ASK — one conversation with the agent whose realm you are standing in (spec 350 §3.5 / §3.6).
//
// The Ask does what the buttons do. Where a settings ceremony collects its inputs in a form and then acts,
// the Ask acts and asks for what it turns out to need — a name, the credential that will custody what it
// makes, a signature, or the AUTHORITY nobody has granted yet. Four replies, and the panel renders each:
//
//   answer              — it only had to read
//   authority_required  — the plan reached a step nobody authorized. The agent says exactly what would
//                         have to be signed; the person signs a MANDATE (one capability, one parent, THIS
//                         ask, one hour) with the credential that custodies the parent, and we come back.
//   prompt              — the tool needs something. `credential` fields are answered HERE, from the
//                         connected session — the person is never asked which key they are holding.
//   done                — it happened; the receipts say under what authority.
//
// WHO IS ASKED vs WHOSE AUTHORITY. The addressee is the realm you are standing in (the workspace switcher's
// active agent). The authority is whatever the step names — the parent whose namespace the action enters:
// a team's workspace, an organization's person. They are usually the same agent and never assumed to be.
// The mandate is signed by the credential that custodies the DELEGATOR, which for everything a person
// steward does is their own credential (an SA validates its custodians' signatures, ERC-1271).
import { createPublicClient, http } from 'viem';
import {
  buildDigestBindingCaveat, capabilityHandler, hashDelegation, paymentHandler, ROOT_AUTHORITY,
  type Caveat, type Delegation, type MandateRequirementV1,
} from '@agenticprimitives/delegation';
import type { Address, Hex } from '@agenticprimitives/types';
import { CHAIN, CHAIN_ID, CONTRACTS } from '../lib/chain';
import { toWire, type DelegationWire } from '../lib/delegation';
import { ensureCsrfToken, csrfHeaders, invalidateCsrfCache } from '../csrf';
import type { SignHash } from './resolution';
import type { AskCredential } from '../components/portal/ask/credential';

/** Is the Ask available on the deployment this build targets? It needs the harness, and the harness needs
 *  `DigestBindingEnforcer` — the caveat that binds a mandate to ONE request. Absent (Base Sepolia today)
 *  ⇒ there is no Ask surface at all, rather than a button that asks for authority nothing can bound. */
export function askIsAvailable(): boolean {
  return !/^0x0{40}$/i.test(CONTRACTS.digestBindingEnforcer ?? '');
}

/** A field the agent wants filled. `credential` is filled by this surface, never shown to the person. */
export interface AskField {
  name: string;
  label: string;
  type: 'text' | 'address' | 'number' | 'boolean' | 'choice' | 'credential';
  required?: boolean;
  /** For `choice`. `hint` is what tells two candidates apart — kind, address, where they are known from. */
  choices?: Array<{ value: string; label: string; hint?: string }>;
  /** The listed candidates are not the only answers — the surface must also accept a typed one. */
  allowOther?: boolean;
  pattern?: string;
  hint?: string;
}

/** A follow-up the agent suggests when a question has no good answer on hand. Prefilled, never sent. */
export interface AskSuggestion { label: string; message: string }

export type AskPrompt =
  | { kind: 'data'; stepRef: string; toolId: string; prompt: string; fields: AskField[] ; suggest?: AskSuggestion }
  | { kind: 'signature'; stepRef: string; toolId: string; prompt: string; digest: Hex; signer: string; payload?: unknown }
  | { kind: 'confirmation'; stepRef: string; toolId: string; prompt: string; summary: unknown };

/** One step showing its work: which tool ran, how it read the question, and what it sent. */
export interface AskEvidence {
  toolId: string;
  interpretation?: string;
  query?: string;
  count?: number;
  /** What a keyword search looked for — the difference between "none exist" and "no name matched". */
  searched?: string;
  reason?: string;
}

export type AskReplyVariant =
  | { kind: 'answer'; text: string; runRef: string;
      /** Spec 361 — the structured result, when THIS surface supplied the plan. A screen renders rows;
       *  parsing the composed sentence would make it disagree with the record eventually. */
      results?: Array<{ toolId: string; result: unknown }>;
      /** HOW IT KNOWS. When a step wrote a query to answer, the query comes back with the answer —
       *  otherwise "the directory does not list any organizations" and "I searched names for the word
       *  'organizations' and matched none" are the same sentence to a reader, and only one of them is
       *  true (spec 357 §4). Display only; it decides nothing. */
      evidence?: AskEvidence[] }
  | { kind: 'authority_required'; runRef: string; requirement: MandateRequirementV1; delegate: Address; delegator: Address; capability: string; stepRef: string; summary: string;
      /** What the ASKER is to the delegator, derived by the agent from evidence the chain confirms
       *  (spec 353 S5). It explains; it never decides — custody at grant time does that. */
      standing?: { relation: 'self' | 'steward' | 'member' | 'none'; because: string; canGrant: boolean };
      note?: string;
      /** Spec 361 I4 — other digests the act needs from the SAME delegator; approveHash'd with the
       *  mandate's in one userOp (one signature). */
      alsoApprove?: { purpose: string; digest: `0x${string}` }[];
      /** What the words became. "send nathan a message" is authorized against an ADDRESS; this is where a
       *  person sees which one, before they sign rather than after. */
      parties?: Array<{
        arg: string; raw: string; agent: string; label?: string; hint?: string;
        /** Spec 363 — why a party was DECIDED rather than asked, in the deciding rule's own words. */
        because?: string; ruleId?: string;
      }> }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: AskPrompt }
  /** Spec 374 — the run waits on ANOTHER agent's steward; not resumable here. `on` is where it waits. */
  | { kind: 'waiting'; runRef: string; stepRef: string; text: string; on: { agent: string; name?: string; runRef: string }; spoken?: string }
  | { kind: 'done'; runRef: string; result: unknown; receipts: unknown[];
      /** Spec 367 §6 — what the act ESTABLISHED: a submission is said as a submission, never as the outcome. */
      fulfillment?: { capability: string; established: 'lookup' | 'submission' | 'authoritative'; evidence?: string; words: string };
      /** Spec 361 — where the outcome lives, from the acted capability's CONTRACT (never a hand-kept
       *  capability→route table here). Resolved through the app's interaction registry. */
      interaction?: { result?: string; navigationTarget?: string };
      /** Spec 360 — what FOLLOWED the act, and whether it reached anyone. Shown, always: a receipt that
       *  could not be delivered is the difference between "they were told" and "they will never know". */
      effects?: Array<{ produces: string; ok: boolean; error?: string }>;
      /** Spec 363 W6 — what was DECIDED for the person on the way here, and on what basis. */
      decisions?: Array<{ point: string; ruleId: string; arg: string; chose: string; because: string }>;
      /** Spec 366/376 — steps another agent did: routed to its subject, or HANDED to a specialist under a child mandate. */
      routed?: Array<{ agent: string; name?: string | null; observedVia?: string; runRef?: string; childRef?: string; receipts?: number; /** Spec 383 W2 — the standing the receiver's receipt names: for whom, by whom, under which steward wire (digest). */ standing?: { relation: string; subject: string; principal: string; because: string; wireRef?: string } }>;
      /** Spec 368 §3 — what MAY FOLLOW: a compiled command the agent proposes (e.g. "invite Bob to your
       *  household as spouse" after a household note). A proposal only — confirming it runs a new turn
       *  that asks for its own authority. */
      next?: { capability: string; args: Record<string, unknown>; words: string; why?: string } }
  | { kind: 'refused'; runRef: string; outcome: string; error: string; receipts: unknown[] };

/** Spec 367 wave 1 — what the planner actually received on this turn (mirror of the a2a `PlannerTraceV1`). Display only. */
export interface PlannerTrace {
  planner: string;
  /** Spec 377 — the concrete model that planned (`openai/gpt-oss-120b`), when a model did. */
  model?: string;
  toolsExposed: string[];
  playbook: { archetypeId: string; archetypeVersion: string; digest: string } | null;
  promptDigest: string;
  examplesRendered: number;
  admission: Array<{ refused: Array<{ code: string; message: string; stepIndex?: number; toolId?: string }>; replanned: boolean }>;
  plan: Array<{ toolId: string; args: Record<string, unknown> }>;
  bindings: Array<{ arg: string; raw: string; agent: string; label?: string; source: string; because?: string }>;
  surface?: { realm?: string; capabilities?: number; channel?: 'text' | 'voice' };
  recalledTurns?: number;
  /** How much of the playbook's instructions the planner was shown (the doctrine of the whole). */
  instructionsRendered?: { chars: number; of: number };
  /** A provider's prompt budget and every named part dropped to meet it, in order (spec 377). */
  promptBudget?: { tokens: number; estimated: number; trimmed: string[] };
}

/** Spec 377 — one model the agent OFFERS for an Ask: the provider id a turn names, the words the picker
 *  shows, the concrete model behind it, and whether it is the one a turn gets when it names none. */
export interface AskModelOption { id: string; label: string; model: string; free: boolean; default: boolean }
export type AskReply = AskReplyVariant & {
  plannerTrace?: PlannerTrace;
  /** Spec 369 — what a VOICE says for this reply, decided by the agent (markdown stripped, addresses named;
   *  authority and signatures are read, never answered). */
  spoken?: string;
};

/** Spec 361 I5 — THE DRAFT: a suspended run's sentence, plan and answers, as a screen reads them. */
export interface RunDraft { runRef: string; addressee: string; message: string; plan?: { steps: Array<{ toolId: string; args: Record<string, unknown> }> }; supplied: SuppliedInput[]; awaiting: { kind: string; prompt: string; stepRef: string } | null; presentedCount: number }
export async function readDraft(session: { token: string }, addressee: string, runRef: string): Promise<RunDraft | null> {
  const r = await fetch(`/a2a/harness/run?session=${encodeURIComponent(session.token)}&addressee=${addressee.toLowerCase()}&runRef=${encodeURIComponent(runRef)}`, { credentials: 'include' });
  const b = (await r.json().catch(() => ({}))) as RunDraft & { ok?: boolean };
  return r.ok && b.ok ? b : null;
}

/** Answers carried into the next turn of the SAME ask. */
export interface SuppliedInput {
  stepRef: string;
  data?: Record<string, unknown>;
  signature?: { digest: string; signer: string; signature: string; payload?: unknown };
  confirmed?: boolean;
}

/**
 * The state one ask carries between turns.
 *
 * Spec 350 W3 made most of it the AGENT'S to remember: once a run has suspended, the agent holds the
 * question, the mandate and every answer under `runRef`, and a resume needs only the runRef plus what is
 * new. So `resumable` marks the point where this surface stops re-sending the mandate — it is authority,
 * and authority sitting in browser memory across turns is a window nobody needed to leave open.
 *
 * What does NOT change: a resume is a full re-run through every gate. The agent re-plans the stored
 * question, re-verifies the stored mandate on chain, re-applies the ladder and re-checks the approval,
 * every turn. The checkpoint carries inputs, never conclusions.
 */
/** What THIS app can carry to completion, and where the person is standing. The agent narrows what it
 *  offers to this — it can never widen it, and naming a capability does not permit it (the mandate still
 *  decides). Sent so a plan is never made of steps this surface has no ceremony for. */
export interface AskSurface {
  capabilities?: string[];
  ceremonies?: string[];
  /** Where the person is standing — NOT what they are to it. Standing (steward, member, role) is the
   *  agent's to derive from vault and chain: an app that asserts it is supplying an authorization claim,
   *  which is the pattern ADR-0041 forbids (spec 353 §4). */
  realm?: { kind?: 'person' | 'org' | 'service' };
  /** Spec 361 I6 — the entity selected on the screen the Ask was opened from (a checked reference). */
  selection?: { entity?: string; kind?: string; label?: string; filter?: Record<string, string>; draftRunRef?: string };
}

/**
 * WHAT THIS SURFACE CAN RENDER — the Home's half of the scope, and the honest half.
 *
 * The flyout collects data fields, a confirmation, and a signature from the connected credential. It has
 * nowhere to collect a SECOND PARTY's approval, so it does not claim one. A capability whose ceremonies
 * include `approval` is therefore not offered here — correctly: a plan that reaches it would suspend on a
 * prompt this surface cannot answer, after the person has already been asked for everything else.
 */
export const HOME_CEREMONIES = ['data', 'confirmation', 'signature'] as const;

/** One agent's published Ask vocabulary. Disclosure only — every id still needs a mandate. */
/** Spec 367 §7 — one field of the command behind a capability, typed by the ontology class its contract gave it. */
export interface CommandField { name: string; label: string; kind: 'agent' | 'amount' | 'text' | 'flag' | 'asset'; required: boolean; types?: string[]; acceptsEmail?: boolean; hint?: string }
export interface AskVocabularyEntry {
  id: string; description?: string; riskTier: string; ceremonies: string[]; label?: string; fields?: CommandField[];
  /** Spec 398 §7.2 — how many times the act may land for one request (the retry affordance), from the contract. */
  idempotency?: 'one-per-request' | 'one-per-resource-version' | 'replay-safe';
  /** Spec 398 §7.2 — the closed kind of what comes back. */
  resultKind?: 'artifact' | 'receipt' | 'membership' | 'message' | 'decision' | 'listing';
}

/**
 * The scope this surface declares: the INTERSECTION of what the agent publishes and what this app can
 * finish (spec 353 S2/S4).
 *
 * Generated, never hand-kept. A curated list here would be a fourth place capability ids live, and the
 * one that silently shrinks what a person can do when somebody forgets to add to it. If the vocabulary
 * cannot be read we send NO capability list at all — silence is correctly not a narrowing (a surface that
 * has not said what it can do is not narrowed by its silence), so a fetch failure costs honesty, never
 * function.
 */
const vocabularyMemo = new Map<string, { at: number; caps: AskVocabularyEntry[]; models: AskModelOption[] }>();
const VOCABULARY_TTL_MS = 5 * 60_000;

/** One read of the vocabulary endpoint, memoised: the capabilities AND the models offered ride together. */
async function readVocabulary(agent?: string): Promise<{ caps: AskVocabularyEntry[]; models: AskModelOption[] } | null> {
  const memoKey = (agent ?? '').toLowerCase();
  const cached = vocabularyMemo.get(memoKey);
  if (cached && Date.now() - cached.at < VOCABULARY_TTL_MS) return cached;
  try {
    const r = await fetch(`/a2a/harness/vocabulary${memoKey ? `?agent=${memoKey}` : ''}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { capabilities?: AskVocabularyEntry[]; models?: AskModelOption[] };
    if (body.capabilities) {
      const entry = { at: Date.now(), caps: body.capabilities, models: Array.isArray(body.models) ? body.models : [] };
      vocabularyMemo.set(memoKey, entry);
      return entry;
    }
  } catch { /* no vocabulary ⇒ no commands to offer; the sentence path still works */ }
  return null;
}

/** The agent's published vocabulary entries (with command fields), memoised like `homeScope`. */
export async function homeVocabulary(agent?: string): Promise<AskVocabularyEntry[]> {
  return (await readVocabulary(agent))?.caps ?? [];
}

/** Spec 377 — the models the agent OFFERS for an Ask. Empty ⇒ the agent names none (the picker is not
 *  shown and a turn names no model; the deployment default runs). Shares the vocabulary read. */
export async function homeModels(agent?: string): Promise<AskModelOption[]> {
  return (await readVocabulary(agent))?.models ?? [];
}

export async function homeScope(
  realm?: { kind?: 'person' | 'org' | 'service' },
  /** The agent being asked. When given, the published vocabulary is narrowed to its assigned archetype
   *  (spec 354 §4.4 / K5) — the classification vocabulary is `app ∩ this agent's definition capabilities`.
   *  Memoised per agent, because two agents on the same Home publish different vocabularies. */
  agent?: string,
  /** Spec 361 I6 — what is selected on the screen, so a party the sentence did not name can be filled from it. */
  selection?: AskSurface['selection'],
): Promise<AskSurface> {
  const ceremonies = [...HOME_CEREMONIES];
  const surface: AskSurface = { ceremonies, ...(realm ? { realm } : {}), ...(selection ? { selection } : {}) };
  try {
    // Cache-first, and the cache holds the canonical answer rather than a cheaper substitute for it
    // (ADR-0013). A capability list changes when the agent is redeployed, so minutes is the right
    // granularity — and a stale list can only ever narrow, never widen, what the agent will do.
    const memoKey = (agent ?? '').toLowerCase();
    const cached = vocabularyMemo.get(memoKey);
    const fresh = cached && Date.now() - cached.at < VOCABULARY_TTL_MS ? cached.caps : null;
    if (fresh) {
      const renders = new Set<string>(ceremonies);
      return { ...surface, capabilities: fresh.filter((c) => (c.ceremonies ?? []).every((x) => renders.has(x))).map((c) => c.id) };
    }
    const read = await readVocabulary(agent);
    if (!read) return surface;
    const renders = new Set<string>(ceremonies);
    const usable = read.caps.filter((c) => (c.ceremonies ?? []).every((x) => renders.has(x)));
    // An empty intersection is a real answer and must not read as "no scope declared": send the empty
    // list, and the agent offers nothing rather than everything.
    return usable.length || read.caps.length ? { ...surface, capabilities: usable.map((c) => c.id) } : surface;
  } catch {
    return surface;
  }
}

export interface AskTurnState {
  /** Spec 369 — the words arrived by voice (the agent's own transcript). Trace only. */
  channel?: 'text' | 'voice';
  message: string;
  addressee: Address;
  surface?: AskSurface;
  /** Spec 361 I4 / 367 §7 — a SCREEN's own plan: the command it knows, with the person's words as arguments.
   *  Sent on the first turn only; a resume carries the runRef and the agent holds the plan. */
  plan?: { steps: Array<{ toolId: string; args: Record<string, unknown> }> };
  runRef: string;
  presented: DelegationWire | null;
  supplied: SuppliedInput[];
  /** Set once the agent has checkpointed this run: later turns send the runRef and the new answers only. */
  resumable?: boolean;
  /** Spec 377 — the provider the person chose for this conversation (`AskModelOption.id`). Sent on EVERY
   *  turn of a run so a resume composes with it too. Absent ⇒ the agent's default. */
  model?: string;
}

/** An unfinished run on the agent being asked, that this person may pick up (spec 350 W3). A handle and
 *  what it waits for — never the mandates, which only a resume hands back. */
export interface UnfinishedRun { runRef: string; message: string; awaiting: { kind: string; prompt: string; stepRef: string } | null; updatedAt: number }

async function post(body: unknown): Promise<{ ok: boolean; reply?: AskReply; resumable?: boolean; error?: string; detail?: string; waiting?: string; unfinishedRuns?: UnfinishedRun[]; unfinishedTotal?: number }> {
  // Spec 402 W3 — the person's zone rides on every turn: a routine's clock ("every Monday at 8") is read in her day.
  const tz = ((): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
  return postA2a('/a2a/harness/ask', tz && body && typeof body === 'object' ? { tz, ...(body as Record<string, unknown>) } : body) as never;
}

/** Spec 385 W2 — one remembered choice: for THIS word, filling THIS argument of THIS capability, the person
 *  once picked THIS agent. Evidence the resolver cites ("remembered: you chose … for this before"), never a
 *  grant; shown so it can be cleared. `capabilityWords` is the agent's phrase for the capability. */
/** `context` = the room the choice was made in (spec 385 W2); absent = made at home. It is part of the memory's key. */
export interface RememberedChoice { word: string; capability: string; capabilityWords: string; arg: string; agent: string; label?: string; at: string; runRef?: string; context?: string }

/** The person's own remembered choices — theirs alone, whatever room they are asking in. */
export async function listConfirmations(session: { token: string }): Promise<RememberedChoice[]> {
  const out = (await postA2a('/a2a/harness/confirmations', { session: session.token })) as { ok?: boolean; entries?: RememberedChoice[] };
  return out.ok ? out.entries ?? [] : [];
}

/** Spec 402 W1 — one remembered FACT: what the person's agent knows about them, in their words, dated, with who said it. */
export interface RememberedFact { id: string; fact: string; learnedAt: string; source: 'you' | 'agent' | 'connector'; saidAs?: string; runRef?: string; from?: string; tags?: string[] }

/** What the person's agent remembers about them — theirs alone. */
export async function listFacts(session: { token: string }): Promise<RememberedFact[]> {
  const out = (await postA2a('/a2a/harness/memory', { session: session.token })) as { ok?: boolean; entries?: RememberedFact[] };
  return out.ok ? out.entries ?? [] : [];
}
/** The same read, with the reason when it could not be made (a grant that predates the scope says `record_scope_denied`). */
export async function listFactsOrWhy(session: { token: string }): Promise<{ ok: true; entries: RememberedFact[] } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/memory', { session: session.token })) as { ok?: boolean; entries?: RememberedFact[]; error?: string; detail?: string };
  return out.ok ? { ok: true, entries: out.entries ?? [] } : { ok: false, error: out.detail ?? out.error ?? 'memory could not be read' };
}
/** Forget one remembered fact; a receipt that cited it keeps its citation. */
export async function forgetFact(session: { token: string }, id: string): Promise<{ ok: true; entries: RememberedFact[] } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/memory/forget', { session: session.token, id })) as { ok?: boolean; entries?: RememberedFact[]; error?: string };
  return out.ok ? { ok: true, entries: out.entries ?? [] } : { ok: false, error: out.error ?? 'the fact could not be forgotten' };
}

/** Spec 394 — one standing instruction: in THIS room (`any` or an organization's address), when the person does THIS act,
 *  THIS argument defaults to THIS agent unless they say otherwise. Evidence the resolver cites (`standing`), never a
 *  grant; shown so it can be cleared. */
export interface StandingInstruction { context: string; capability: string; capabilityWords: string; arg: string; value: string; label?: string; saidAs?: string; at: string; runRef?: string }

/** The person's own standing instructions — theirs alone, whatever room they are asking in. */
export async function listInstructions(session: { token: string }): Promise<StandingInstruction[]> {
  const out = (await postA2a('/a2a/harness/instructions', { session: session.token })) as { ok?: boolean; entries?: StandingInstruction[] };
  return out.ok ? out.entries ?? [] : [];
}

/** Clear one standing instruction; the next act of that kind, in that room, asks for the argument again. */
export async function forgetInstruction(session: { token: string }, scope: { context: string; capability: string; arg: string }): Promise<{ ok: true; entries: StandingInstruction[] } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/instructions/forget', { session: session.token, scope })) as { ok?: boolean; entries?: StandingInstruction[]; error?: string };
  return out.ok ? { ok: true, entries: out.entries ?? [] } : { ok: false, error: out.error ?? 'the instruction could not be cleared' };
}

/** Clear one remembered scope; the next ask of that word, in that place, asks again. Returns what remains. */
export async function forgetConfirmation(session: { token: string }, scope: { word: string; capability: string; arg: string; context?: string }): Promise<{ ok: true; entries: RememberedChoice[] } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/confirmations/forget', { session: session.token, scope })) as { ok?: boolean; entries?: RememberedChoice[]; error?: string };
  return out.ok ? { ok: true, entries: out.entries ?? [] } : { ok: false, error: out.error ?? 'the choice could not be cleared' };
}

/**
 * Spec 369 — THE AGENT HEARS. The recording goes to the asker's own agent, which transcribes it biased by what
 * it knows about them and repairs the names it can prove; the words come back to be SEEN, then sent through
 * `ask()` like typed ones. Audio is processed and discarded on the agent. A failure is said, never papered
 * over by the browser's recognizer (ADR-0013).
 */
export async function hear(session: { token: string }, addressee: string, audioBase64: string, mime: string): Promise<
  { ok: true; transcript: string; heard: string; repairs: Array<{ from: string; to: string }> } | { ok: false; error: string }
> {
  const res = await postA2a('/a2a/harness/hear', { session: session.token, addressee: addressee.toLowerCase(), audio: audioBase64, mime, language: (typeof navigator !== 'undefined' ? navigator.language : 'en').split('-')[0] }) as
    { ok: boolean; transcript?: string; heard?: string; repairs?: Array<{ from: string; to: string }>; error?: string; detail?: string };
  if (!res.ok || typeof res.transcript !== 'string') return { ok: false, error: res.detail ?? res.error ?? 'the agent could not hear that' };
  return { ok: true, transcript: res.transcript, heard: res.heard ?? res.transcript, repairs: res.repairs ?? [] };
}

/** Warm the agent's ear for this asker while the mic is still open — the vocabulary reads cost seconds the
 *  recording hides; fire-and-forget, a failure costs nothing but a slower first hearing. */
export function warmHearing(session: { token: string }, addressee: string): void {
  void postA2a('/a2a/harness/hear', { session: session.token, addressee: addressee.toLowerCase(), warm: true }).catch(() => undefined);
}

export async function postA2a(path: string, body: unknown): Promise<Record<string, unknown>> {
  const send = async () => {
    await ensureCsrfToken();
    return fetch(path, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify(body),
    });
  };
  let r = await send();
  // A REJECTED TOKEN IS RECOVERABLE, and it must be recovered here. A stale one — a cookie left by the
  // apex host, a server-side rotation — made every ask fail with "csrf invalid" and stay failed, because
  // nothing ever asked for a new one. This is a bounded retry of the SAME request after re-minting, not a
  // second mechanism (ADR-0013): one more attempt, then the error stands.
  if (r.status === 403) {
    invalidateCsrfCache();
    r = await send();
  }
  return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as never;
}

/** Spec 350 W3 — the runs parked on an agent that this person may pick up, with what each waits for and where it
 *  came from (a committed step names its endeavor and step). Never the mandates. */
export interface ParkedRun { runRef: string; message: string; awaiting?: { kind: string; prompt: string; stepRef: string } | null; updatedAt: number; /** the state the runtime projected (398 §5.1) */ state?: string; origin?: { endeavorId?: string; stepId?: string; principal?: string; commitmentRef?: string } }
/** Spec 381 W3 — one span of a run's provenance, as the Worker exports it after the firewall (ids and named
 *  attributes only; no bodies, no keys). A link names a span of ANOTHER run in the same trace (a hand-off). */
export interface SpanRow {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: string;
  startMs: number; endMs: number; status: string; attributes: Record<string, string | number | boolean>;
  links?: Array<{ traceId: string; spanId: string; attributes?: Record<string, string | number | boolean> }>;
}
export interface RunProvenance { spans: SpanRow[]; retention?: unknown; exporter?: string; export?: unknown }

/** Spec 381 W3 — one finished run of an agent, as the record listing carries it (no mandates, no events). */
export interface RunRecordRow {
  runRef: string; at: number; outcome: string; steps: number; receipts: number;
  /** Spec 398 §5.3 — the run was stopped by the person who could resume it, after `afterSteps` completed steps. */
  canceled?: { at: number; by: string; afterSteps: number; note?: string };
  intent: { goal: string; context?: Record<string, unknown> };
  export?: { ok?: boolean; where?: string; error?: string } | null;
}

/** Spec 381 W3 — the runs this person asked of an agent (theirs to look back on; the Worker refuses others'). */
export async function listRunRecords(session: { token: string }, addressee: Address): Promise<{ records: RunRecordRow[]; retention?: unknown }> {
  const out = (await postA2a('/a2a/harness/records', { session: session.token, addressee })) as { ok?: boolean; records?: RunRecordRow[]; retention?: unknown };
  return out.ok ? { records: out.records ?? [], retention: out.retention } : { records: [] };
}

/** Spec 381 W3 — WHAT MY AGENT DID, from the vault: the spans of one run the person asked for, read back under
 *  their session (the Worker refuses a run that was not theirs). The same bytes an OTLP exporter would carry. */
/** Spec 395 — the run's PUBLIC projection: its anchored outcomes (digests and ids through the S1 firewall), readable by
 *  anyone with no session. What a counterparty holding a receipt can verify against; nothing the run was about. */
export interface AnchoredOutcome { '@id': string; run: string; anchoredBy: string; assurance: string; receiptDigest?: string; chainDigest?: string; intentDigest?: string; playbook?: string; capability?: string; completionState: string; endedAt?: string }
export async function fetchPublicProvenance(agent: Address, runRef: string): Promise<{ rows: AnchoredOutcome[]; refused: Array<{ activity: string; reason: string }> } | { error: string }> {
  const out = (await postA2a('/a2a/provenance/public', { agent, runRef })) as { ok?: boolean; error?: string; rows?: AnchoredOutcome[]; refused?: Array<{ activity: string; reason: string }> };
  return out.ok ? { rows: out.rows ?? [], refused: out.refused ?? [] } : { error: out.error ?? 'the public projection could not be read' };
}

/** Spec 389 W3 — THE RUN AS A PROV GRAPH: the JSON-LD document the agent's vault holds (rebuilt from the record), or
 *  PROV-N, read back under the person's session. `hasProvenance` names where the durable copy is. */
export async function fetchProvenance(session: { token: string }, addressee: Address, runRef: string, format: 'jsonld' | 'prov-n' = 'jsonld'): Promise<{ text: string; hasProvenance?: { agent: string; recordType: string } } | { error: string }> {
  const out = (await postA2a('/a2a/harness/provenance', { session: session.token, addressee, runRef, format })) as { ok?: boolean; error?: string; provenance?: unknown; provN?: string; hasProvenance?: { agent: string; recordType: string } };
  if (!out.ok) return { error: out.error ?? 'the provenance could not be read back' };
  return { text: format === 'prov-n' ? String(out.provN ?? '') : JSON.stringify(out.provenance, null, 2), ...(out.hasProvenance ? { hasProvenance: out.hasProvenance } : {}) };
}

/** Spec 398 §5.2 — THE INSPECTOR'S RECORD: what the run left, decided, spent authority on and cost, per step —
 *  digests, verdicts and names, never arguments or words (the same firewall the PROV graph passes). */
export interface RunInspectorStep {
  stepRef: string; toolId: string; capability?: { id: string; action: string }; risk?: string; status: string;
  startedAt?: string; endedAt?: string;
  authority?: { presentedRef: string | null; decision: string; afterApproval: boolean; chain?: { depth: number; chainDigest: string; accountabilityRoot: string; actingAgent: string } };
  actor?: { rootPrincipal?: string; originatingAgent?: string; actingAgent: string };
  receiptDigest?: string; txHash?: string; delegatedTo?: string; delegatedToRun?: string;
  artifact?: { recordType: string; digest: string; bytes: number };
  effects?: Array<{ produces: string; ok: boolean }>;
  decisions?: Array<{ point: string; ruleId: string }>;
  errorClass?: string;
}
export interface RunInspectorRecord {
  runRef: string; endedAt: string; agent: string; asker?: string; outcome: string; chainId?: number;
  playbook?: { skillId: string; version: string; commitment: string };
  inResponseTo?: { agent: string; runRef: string; stepRef?: string };
  steps: RunInspectorStep[];
  bill?: { vaultCalls: number; doRequests: number; byStep: Record<string, { vaultCalls: number; doRequests: number }> };
  canceled?: { at: number; by: string; afterSteps: number; note?: string };
  plannedSteps?: number;
}
export async function fetchRunInspector(session: { token: string }, addressee: Address, runRef: string): Promise<RunInspectorRecord | { error: string }> {
  const out = (await postA2a('/a2a/harness/provenance', { session: session.token, addressee, runRef, format: 'record' })) as { ok?: boolean; error?: string; record?: RunInspectorRecord };
  return out.ok && out.record ? out.record : { error: out.error ?? 'the run could not be read back' };
}

export async function fetchSpans(session: { token: string }, addressee: Address, runRef: string): Promise<RunProvenance | { error: string }> {
  const out = (await postA2a('/a2a/harness/spans', { session: session.token, addressee, runRef })) as { ok?: boolean; error?: string } & Partial<RunProvenance>;
  return out.ok ? { spans: out.spans ?? [], retention: out.retention, ...(out.exporter ? { exporter: out.exporter } : {}), export: out.export ?? null } : { error: out.error ?? 'the run could not be read back' };
}

/** Spec 398 §5 / APUX-034 — the DRAFT RECIPE a completed run becomes: the runtime composes it from the record and the
 *  playbook (never from a key); saving it in the Library is the person's act, done here. */
export interface RecipeDraft { name: string; fileName: string; capabilities: string[]; roles: Array<{ role: string; from: string; firstBoundTo?: string }>; steps: Array<{ n: number; capability: string; args: Record<string, unknown>; risk?: string; action?: string }>; skillMd: string; notes: string[] }
export async function draftRecipeOf(session: { token: string }, addressee: Address, runRef: string): Promise<{ ok: true; recipe: RecipeDraft; playbookRead: boolean } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/recipe', { session: session.token, addressee, runRef })) as { ok?: boolean; error?: string; recipe?: RecipeDraft; playbookRead?: boolean };
  return out.ok && out.recipe ? { ok: true, recipe: out.recipe, playbookRead: out.playbookRead === true } : { ok: false, error: out.error ?? 'the run could not be drafted as a recipe' };
}

/** Spec 398 §5.3 — CANCEL an unfinished run: it stops; what already happened stands (steps 1–N and their receipts).
 *  One of four distinct controls — not a pause (a trigger's), not a revoke (a delegation's, under Security), not an
 *  undo (a new intent with its own mandate). Only whoever could resume the run may stop it. */
export async function cancelRun(session: { token: string }, addressee: Address, runRef: string, note?: string): Promise<{ ok: true; stoppedAfter: number; happened: string[] } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/cancel', { session: session.token, addressee, runRef, ...(note ? { note } : {}) })) as { ok?: boolean; error?: string; stoppedAfter?: number; happened?: string[] };
  return out.ok ? { ok: true, stoppedAfter: out.stoppedAfter ?? 0, happened: out.happened ?? [] } : { ok: false, error: out.error ?? 'the run could not be stopped' };
}

export async function listRuns(session: { token: string }, addressee: Address): Promise<ParkedRun[]> {
  const out = (await postA2a('/a2a/harness/runs', { session: session.token, addressee })) as { ok?: boolean; runs?: ParkedRun[] };
  return out.ok ? out.runs ?? [] : [];
}

/** Spec 370 P5 / 375 — one row of the agent's schedule: what its playbook asks on its own, fired by what, and
 *  what the last firing reached. A webhook row carries its bearer token (admission, never authority). */
export interface TriggerRow {
  triggerId: string; kind?: 'schedule' | 'event' | 'webhook' | 'message'; ask: string;
  every?: string; nextAt?: number; on?: { event?: string; profile?: string }; token?: string;
  lastAt?: number; lastRunRef?: string; lastOutcome?: 'answered' | 'parked' | 'failed'; lastSaid?: string;
  /** Spec 398 §5.3 — paused: nothing new starts; by a steward, or by the budget (§5.4). */
  paused?: { at: number; by: 'steward' | 'budget'; note?: string };
  /** Spec 398 §5.4 — vault calls per firing; exhaustion pauses. */
  /** `declared` — written on the SKILL.md trigger itself (398 §5.4); otherwise a steward set it on the row. */
  budget?: { vaultCalls: number; declared?: true };
  lastBill?: { vaultCalls: number; doRequests: number };
  /** Spec 402 W3 — a routine the person DECLARED from a sentence (hers, not the playbook's): who, when, her words, her zone. */
  declared?: { by: string; at: number; saidAs: string; when: string; tz: string; name?: string };
}

/** Spec 402 W3 — remove a routine the person declared (a playbook's routine goes with the playbook). */
export async function removeTrigger(session: { token: string }, addressee: Address, triggerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/triggers/remove', { session: session.token, addressee, triggerId })) as { ok?: boolean; error?: string };
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'the routine could not be removed' };
}

/** Spec 398 §5.3 / §5.4 — pause or resume a routine, or set its budget (null clears). Stewards only. */
export async function pauseTrigger(session: { token: string }, addressee: Address, triggerId: string, change: { paused?: boolean; note?: string; budget?: { vaultCalls: number } | null }): Promise<{ ok: true; trigger: TriggerRow } | { ok: false; error: string }> {
  const out = (await postA2a('/a2a/harness/triggers/pause', { session: session.token, addressee, triggerId, ...change })) as { ok?: boolean; error?: string; trigger?: TriggerRow };
  return out.ok && out.trigger ? { ok: true, trigger: out.trigger } : { ok: false, error: out.error ?? 'the routine could not be changed' };
}

/** What fires a row, in words — the source a steward reads beside the ask. Pure; display only. */
export function triggerSourceLabel(row: TriggerRow, hookUrl?: string): string {
  switch (row.kind ?? 'schedule') {
    case 'event': return `when ${row.on?.event ?? 'an Endeavor event'} is committed on this agent's log`;
    case 'message': return `when a ${row.on?.profile === 'dm' ? 'direct message' : row.on?.profile ?? 'message'} is admitted into this agent's inbox`;
    case 'webhook': return hookUrl ? `when ${hookUrl} is called with this row's token` : 'when its hook is called with this row\'s token';
    default: return row.every ? `every ${row.every.replace(/^P(T)?/, '').toLowerCase().replace('24h', 'day').replace('7d', 'week').replace(/(\d+)h$/, '$1 hours').replace(/(\d+)d$/, '$1 days')}` : 'on a schedule';
  }
}

/** The agent's schedule (stewards only): the rows its playbook declares. */
export async function listTriggers(session: { token: string }, addressee: Address): Promise<TriggerRow[]> {
  const out = (await postA2a('/a2a/harness/triggers', { session: session.token, addressee })) as { ok?: boolean; triggers?: TriggerRow[]; error?: string };
  if (!out.ok) throw new Error(out.error ?? 'the schedule could not be read');
  return out.triggers ?? [];
}

/** Run one trigger now, as its source would. Returns what the firing reached. */
export async function fireTrigger(session: { token: string }, addressee: Address, triggerId: string): Promise<{ outcome: string; said?: string; runRef: string }> {
  const out = (await postA2a('/a2a/harness/triggers/fire', { session: session.token, addressee, triggerId })) as { ok?: boolean; outcome?: string; said?: string; runRef?: string; error?: string };
  if (!out.ok) throw new Error(out.error ?? 'the trigger did not fire');
  return { outcome: out.outcome ?? 'unknown', ...(out.said ? { said: out.said } : {}), runRef: out.runRef ?? '' };
}

/** Spec 375 W3 — mint a webhook row a new token; the old one stops opening the door. */
export async function rotateTrigger(session: { token: string }, addressee: Address, triggerId: string): Promise<TriggerRow> {
  const out = (await postA2a('/a2a/harness/triggers/rotate', { session: session.token, addressee, triggerId })) as { ok?: boolean; trigger?: TriggerRow; error?: string };
  if (!out.ok || !out.trigger) throw new Error(out.error ?? 'the token was not rotated');
  return out.trigger;
}

/** Spec 370 P2 — one sentence the agent said about its own progress, as the run went. */
export interface ProgressLine { seq: number; at: number; type: string; stepRef?: string; toolId?: string; said: string; terminal?: boolean }

/** The run's progress lines after `after`, held by the agent for up to ~3 s until there is something new
 *  (a long poll). `known:false` = nothing recorded yet for this runRef. */
export async function readProgress(session: { token: string }, addressee: Address, runRef: string, after: number): Promise<{ lines: ProgressLine[]; terminal: boolean; known: boolean }> {
  const res = await postA2a('/a2a/harness/progress', { session: session.token, addressee: addressee.toLowerCase(), runRef, after, wait: 3_000 }) as { ok?: boolean; lines?: ProgressLine[]; terminal?: boolean; known?: boolean };
  if (!res.ok) return { lines: [], terminal: false, known: false };
  return { lines: res.lines ?? [], terminal: !!res.terminal, known: res.known !== false };
}

/** Ask once. The first turn carries only the sentence; later turns carry what the agent asked for. */
export async function ask(session: { token: string }, state: AskTurnState): Promise<{ reply: AskReply; resumable: boolean; waiting?: string; unfinishedRuns?: UnfinishedRun[]; unfinishedTotal?: number }> {
  // What is NEW goes up; what the agent already holds does not. Once a run is checkpointed the question
  // and the earlier answers are its own, so this turn carries the runRef and whatever the person just did.
  //
  // A mandate is the exception, and it has to be: the turn that GRANTS one is a turn on a run that is
  // already resumable, so "the agent is holding this run" cannot mean "it has this". Dropping it here
  // sent the run back to asking for authority it had just been given, forever.
  const res = await post({
    session: session.token,
    addressee: state.addressee,
    runRef: state.runRef,
    ...(state.surface ? { surface: state.surface } : {}),
    ...(state.resumable ? {} : { message: state.message }),
    // A plan travels on the first turn AND on a resume that edits the draft (spec 361 I5): the agent
    // re-plans from the edited version and re-verifies from scratch.
    ...(state.plan ? { plan: state.plan } : {}),
    ...(state.presented ? { presented: state.presented } : {}),
    ...(state.channel ? { channel: state.channel } : {}),
    ...(state.model ? { model: state.model } : {}),
    supplied: state.supplied,
  });
  if (!res.ok || !res.reply) {
    return {
      reply: { kind: 'refused', runRef: state.runRef, outcome: 'failed', error: res.detail ?? res.error ?? 'the agent could not be reached', receipts: [] },
      resumable: false,
    };
  }
  return { reply: res.reply, resumable: !!res.resumable, ...(res.waiting ? { waiting: res.waiting } : {}), ...(res.unfinishedRuns?.length ? { unfinishedRuns: res.unfinishedRuns } : {}), ...(res.unfinishedTotal ? { unfinishedTotal: res.unfinishedTotal } : {}) };
}

const PAYMENT_TYPE = 'urn:ap:rar:treasury.payment.execute';

const CUSTODY_ABI = [
  { type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasPasskey', stateMutability: 'view', inputs: [{ name: 'credentialIdDigest', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;

/**
 * CAN this credential grant authority as `delegator`? Asked BEFORE the person is put through a signing
 * ceremony, because the answer is knowable and the alternative is cruel: they sign, the verifier reads the
 * signature against an SA their key does not custody, and the run comes back "not-live: delegation
 * signature did not verify" — true, unhelpful, and after the fact.
 *
 * An agent can appear in your home's tree without your credential custodying it — a workspace someone else
 * stewards, seeded or handed over. Being in the tree is not custody, and only custody can grant.
 */
export async function canGrantAs(delegator: Address, credential: AskCredential): Promise<boolean> {
  const pub = createPublicClient({ chain: CHAIN, transport: http('/a2a/rpc') });
  const code = await pub.getBytecode({ address: delegator }).catch(() => undefined);
  if (!code || code === '0x') return false; // an undeployed agent custodies nothing — fail closed
  return credential.kind === 'eoa'
    ? (await pub.readContract({ address: delegator, abi: CUSTODY_ABI, functionName: 'isCustodian', args: [credential.address] }).catch(() => false)) === true
    : (await pub.readContract({ address: delegator, abi: CUSTODY_ABI, functionName: 'hasPasskey', args: [credential.credentialIdDigest] }).catch(() => false)) === true;
}

/**
 * Mint the mandate the agent said it would need, and sign it as the DELEGATOR.
 *
 * The caveats are built HERE from the requirement — not accepted from the server — so what the person's
 * credential signs is what this surface computed from what it showed them. The enforcers are the deployed
 * ones this build targets; a deployment with no `DigestBindingEnforcer` cannot bind a mandate to one ask,
 * and we refuse rather than mint a broader authority than the person was shown (ADR-0013: no fallback).
 */
/**
 * THE ONE-PROMPT CEREMONY — spec 361 I4. When an act needs the same delegator's signature on MORE than
 * the mandate (an invitation also needs the org→invitee grant), signing each digest is a prompt per
 * digest. Instead: build the mandate UNSIGNED with the 0x03 approved-hash sentinel, then approveHash
 * its digest AND every `alsoApprove` digest in ONE org userOp — one custodian signature over one
 * userOpHash authorizes everything the act needs. Each wire verifies on chain through the SA's
 * ERC-1271 approved-hash branch (the spec-253 mechanism); nothing here weakens a gate, it batches the
 * consent the gates already require.
 */
export async function mintApprovedMandate(
  reply: Extract<AskReply, { kind: 'authority_required' }>,
  signHash: SignHash,
  session: { token: string },
): Promise<DelegationWire> {
  const enforcers = {
    delegationManager: CONTRACTS.delegationManager, timestamp: CONTRACTS.timestampEnforcer,
    allowedTargets: CONTRACTS.allowedTargetsEnforcer, allowedMethods: CONTRACTS.allowedMethodsEnforcer,
    value: CONTRACTS.valueEnforcer, payment: CONTRACTS.paymentEnforcer, digestBinding: CONTRACTS.digestBindingEnforcer,
  };
  const handler = reply.requirement.type === PAYMENT_TYPE ? paymentHandler : capabilityHandler;
  const caveats: Caveat[] = [
    ...handler.toCaveats(reply.requirement, enforcers as never),
    buildDigestBindingCaveat(enforcers.digestBinding, 'intent', reply.requirement.intentDigest as Hex),
  ];
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: reply.delegator, delegate: reply.delegate, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const mandateDigest = hashDelegation(mandate, CHAIN_ID, CONTRACTS.delegationManager);
  const digests = [mandateDigest, ...(reply.alsoApprove ?? []).map((a) => a.digest as Hex)];

  const j = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>;
  await ensureCsrfToken();
  const H = { 'content-type': 'application/json', ...csrfHeaders() };
  const a = (await j(await fetch('/a2a/harness/authorize', { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify({ session: session.token, delegator: reply.delegator, digests }) }))) as { ok?: boolean; userOpHash?: `0x${string}`; userOp?: Record<string, string>; error?: string };
  if (a.ok !== true || !a.userOpHash) throw new Error(String(a.error ?? 'the approval batch could not be built'));
  // THE prompt. One signature, every authority this act needs.
  const signature = await signHash(a.userOpHash as Hex);
  const b = await j(await fetch('/a2a/harness/authorize', { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify({ session: session.token, delegator: reply.delegator, userOp: a.userOp, signature }) }));
  if (b.ok !== true) throw new Error(String(b.error ?? 'the approval batch was not accepted on chain'));
  mandate.signature = '0x03';
  return toWire(mandate);
}

export async function mintMandate(
  reply: Extract<AskReply, { kind: 'authority_required' }>,
  signHash: SignHash,
): Promise<DelegationWire> {
  const enforcers = {
    delegationManager: CONTRACTS.delegationManager,
    timestamp: CONTRACTS.timestampEnforcer,
    allowedTargets: CONTRACTS.allowedTargetsEnforcer,
    allowedMethods: CONTRACTS.allowedMethodsEnforcer,
    value: CONTRACTS.valueEnforcer,
    payment: CONTRACTS.paymentEnforcer,
    digestBinding: CONTRACTS.digestBindingEnforcer,
  };
  if (/^0x0{40}$/i.test(enforcers.digestBinding)) {
    throw new Error('This deployment cannot grant a mandate: the enforcer that binds authority to one request is not deployed here.');
  }
  const handler = reply.requirement.type === PAYMENT_TYPE ? paymentHandler : capabilityHandler;
  const caveats: Caveat[] = [
    ...handler.toCaveats(reply.requirement, enforcers as never),
    buildDigestBindingCaveat(enforcers.digestBinding, 'intent', reply.requirement.intentDigest as Hex),
  ];
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = 0n;
  for (const b of bytes) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = {
    delegator: reply.delegator, delegate: reply.delegate,
    authority: ROOT_AUTHORITY, caveats, salt, signature: '0x',
  };
  mandate.signature = await signHash(hashDelegation(mandate, CHAIN_ID, CONTRACTS.delegationManager));
  return toWire(mandate);
}

/** What the person is told they are granting. Deliberately plain: a capability, a parent, this request,
 *  and how long — the four things that make a mandate narrower than a login. */
export function describeRequirement(reply: Extract<AskReply, { kind: 'authority_required' }>): {
  capability: string; delegator: Address; expiresInMinutes: number;
} {
  const now = Math.floor(Date.now() / 1000);
  return {
    capability: reply.capability,
    delegator: reply.delegator,
    expiresInMinutes: Math.max(1, Math.round(((reply.requirement.validUntil ?? now) - now) / 60)),
  };
}

/** Human words for the capabilities an Ask can need. Unknown ids fall back to the id itself — an
 *  unfamiliar capability must still be readable, never silently blank. */
/**
 * Plain words for a capability, from the AGENT's published vocabulary.
 *
 * This used to be a hand-kept map here, and it was missing three of the seven — so the card that asks a
 * person to authorize a message said "needs permission to messaging.direct.send", which is an identifier,
 * not a sentence. A surface that keeps its own copy of the agent's vocabulary keeps one that goes stale;
 * the words travel with the capability now, and this only reads them.
 *
 * Falls back to the id when the vocabulary has not been read yet — an unfamiliar capability must still
 * render, and an id is honest where an invented phrase would not be.
 */
export function capabilityWords(id: string): string {
  // A capability's plain words are the same whichever agent published it, so any cached vocabulary
  // answers. Search across the per-agent memo.
  for (const { caps } of vocabularyMemo.values()) {
    const hit = caps.find((c) => c.id === id);
    if (hit) return hit.label ?? id;
  }
  return id;
}
