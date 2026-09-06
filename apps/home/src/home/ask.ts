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

export type AskReply =
  | { kind: 'answer'; text: string; runRef: string;
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
      /** What the words became. "send nathan a message" is authorized against an ADDRESS; this is where a
       *  person sees which one, before they sign rather than after. */
      parties?: Array<{ arg: string; raw: string; agent: string; label?: string; hint?: string }> }
  | { kind: 'prompt'; runRef: string; resumeToken: string; prompt: AskPrompt }
  | { kind: 'done'; runRef: string; result: unknown; receipts: unknown[];
      /** Spec 361 — where the outcome lives, from the acted capability's CONTRACT (never a hand-kept
       *  capability→route table here). Resolved through the app's interaction registry. */
      interaction?: { result?: string; navigationTarget?: string } }
  | { kind: 'refused'; runRef: string; outcome: string; error: string; receipts: unknown[] };

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
export interface AskVocabularyEntry { id: string; description?: string; riskTier: string; ceremonies: string[]; label?: string }

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
const vocabularyMemo = new Map<string, { at: number; caps: AskVocabularyEntry[] }>();
const VOCABULARY_TTL_MS = 5 * 60_000;

export async function homeScope(
  realm?: { kind?: 'person' | 'org' | 'service' },
  /** The agent being asked. When given, the published vocabulary is narrowed to its assigned archetype
   *  (spec 354 §4.4 / K5) — the classification vocabulary is `app ∩ this agent's definition capabilities`.
   *  Memoised per agent, because two agents on the same Home publish different vocabularies. */
  agent?: string,
): Promise<AskSurface> {
  const ceremonies = [...HOME_CEREMONIES];
  const surface: AskSurface = { ceremonies, ...(realm ? { realm } : {}) };
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
    const r = await fetch(`/a2a/harness/vocabulary${memoKey ? `?agent=${memoKey}` : ''}`);
    if (!r.ok) return surface;
    const body = (await r.json()) as { capabilities?: AskVocabularyEntry[] };
    if (body.capabilities) vocabularyMemo.set(memoKey, { at: Date.now(), caps: body.capabilities });
    const renders = new Set<string>(ceremonies);
    const usable = (body.capabilities ?? []).filter((c) => (c.ceremonies ?? []).every((x) => renders.has(x)));
    // An empty intersection is a real answer and must not read as "no scope declared": send the empty
    // list, and the agent offers nothing rather than everything.
    return usable.length || body.capabilities?.length ? { ...surface, capabilities: usable.map((c) => c.id) } : surface;
  } catch {
    return surface;
  }
}

export interface AskTurnState {
  message: string;
  addressee: Address;
  surface?: AskSurface;
  runRef: string;
  presented: DelegationWire | null;
  supplied: SuppliedInput[];
  /** Set once the agent has checkpointed this run: later turns send the runRef and the new answers only. */
  resumable?: boolean;
}

/** An unfinished run on the agent being asked, that this person may pick up (spec 350 W3). A handle and
 *  what it waits for — never the mandates, which only a resume hands back. */
export interface UnfinishedRun { runRef: string; message: string; awaiting: { kind: string; prompt: string; stepRef: string } | null; updatedAt: number }

async function post(body: unknown): Promise<{ ok: boolean; reply?: AskReply; resumable?: boolean; error?: string; detail?: string; waiting?: string; unfinishedRuns?: UnfinishedRun[]; unfinishedTotal?: number }> {
  const send = async () => {
    await ensureCsrfToken();
    return fetch('/a2a/harness/ask', {
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
    ...(state.presented ? { presented: state.presented } : {}),
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
