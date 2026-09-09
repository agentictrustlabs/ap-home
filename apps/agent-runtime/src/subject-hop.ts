// A ROUTED ASK ACROSS DEPLOYMENTS — spec 366 R4. The same envelope, resolved through the card.
//
// Inside one deployment a routed step (spec 366 R1) is made in-process, because a Worker cannot fetch a
// hostname its own account serves. To an agent served ELSEWHERE — an organization on another Home — the
// hop is a network call, and it rides the one wire there is (spec 372 S4): an A2A 1.0 `SendMessage`
// whose `message.metadata` carries the SUBJECT-ASK PROFILE (`SubjectAskV1`), and whose reply comes back
// as the task's `subject-answer` artifact — the receiver's own `/harness/ask` envelope, verbatim.
//
// Resolved through the card, not assumed: the name says where the card is served (the estate's naming
// convention, `hostForName`), and the CARD says where the agent takes A2A 1.0 requests. A card that
// publishes no such interface is an agent that cannot be asked this way, and the sender says so — it
// never reads the subject's records locally instead (R3), and it never guesses a path (ADR-0013).
//
// Everything here is pure: the caller supplies `fetch`; nothing reads a store or a chain.
import { AP_SUBJECT_ASK_EXTENSION_URI, AP_HANDOFF_EXTENSION_URI, validateSubjectAsk, validateHandoff, type SubjectAskV1, type SubjectAnswerV1, type HandoffV1 } from '@agenticprimitives/a2a';
import type { AgentCardV1, MessageV1, TaskV1 } from '@agenticprimitives/a2a/standard';

/** The A2A 1.0 JSON-RPC endpoint a card publishes, or null when it publishes none. */
export function a2aEndpointOf(card: (Pick<AgentCardV1, 'supportedInterfaces'> & { protocolVersion?: string }) | null | undefined): string | null {
  // A RELEASED card (the Studio's, signed) states the protocol version ONCE at the top; the live card
  // states it per interface. Either says 1.x or the interface is not one this hop can use.
  const top = /^1\./.test(String(card?.protocolVersion ?? ''));
  const hit = (card?.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC' && (/^1\./.test(String(i.protocolVersion ?? '')) || (i.protocolVersion === undefined && top)) && typeof i.url === 'string' && /^https:\/\//.test(i.url));
  return hit?.url ?? null;
}

const hex32 = (): string => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** The message that carries a subject-ask over the wire: the goal as text, the profile as metadata. */
export function subjectAskMessage(profile: SubjectAskV1): MessageV1 {
  return {
    messageId: hex32(),
    role: 'ROLE_USER',
    parts: [{ text: profile.request.goal }],
    extensions: [AP_SUBJECT_ASK_EXTENSION_URI],
    metadata: { [AP_SUBJECT_ASK_EXTENSION_URI]: profile },
  };
}

/** The subject-ask a received message carries, validated; null when it carries none. */
export function subjectAskOf(message: Pick<MessageV1, 'metadata'>): { ask: SubjectAskV1 } | { errors: string[] } | null {
  const raw = message.metadata?.[AP_SUBJECT_ASK_EXTENSION_URI];
  if (raw === undefined) return null;
  const v = validateSubjectAsk(raw);
  return v.ok ? { ask: v.ask } : { errors: v.errors };
}

export const SUBJECT_ANSWER_ARTIFACT = 'subject-answer';

/**
 * Appendix M8 — THE RECEIVER'S RUN, NAMED BY THE SENDER. A routed step's run at the subject's agent is
 * addressable before it answers, so the sender can read its progress while it runs and its record can
 * cite it by reference. Derived from the correlation the sender minted; the receiver adopts it for a
 * fresh ask (a resume names the run it continues instead).
 */
export function routedRunRefFor(correlation: { runRef: string; stepRef: string }): string {
  return `routed-${correlation.runRef}-${correlation.stepRef}`.replace(/[^A-Za-z0-9._:-]/g, '_');
}

/** The receiver's `/harness/ask` envelope, as the task's `subject-answer` artifact carries it. */
export function subjectEnvelopeOf(task: Pick<TaskV1, 'artifacts'> | null | undefined): Record<string, unknown> | null {
  const art = (task?.artifacts ?? []).find((a) => a.name === SUBJECT_ANSWER_ARTIFACT);
  const part = art?.parts.find((p) => p.data && typeof p.data === 'object' && !Array.isArray(p.data));
  return part ? (part.data as Record<string, unknown>) : null;
}

export interface SubjectHopInput {
  /** Where the subject's card is served (`https://<host>/.well-known/agent-card.json`). */
  cardUrl: string;
  profile: SubjectAskV1;
  /** `atl:cardDigest` from the subject's name records — the sha256 of the released card's bytes. When the
   *  name pins one, a served card that differs is refused: the pin is the name's word about its card. */
  pinnedDigest?: string;
  /** The asker's Home session — the `Authorization` bearer, which is also the credential the profile names. */
  session: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export type SubjectHopOutcome =
  | { ok: true; endpoint: string; task: TaskV1; envelope: Record<string, unknown> }
  | { ok: false; endpoint?: string; refused: string; status?: number; task?: TaskV1 };

/**
 * The hop: fetch the card, take its 1.0 endpoint, send ONE message, read the artifact. A task that ended
 * without the artifact is relayed in the receiver's status words (a rejection, a need), never retried.
 */
export async function sendSubjectAskOverWire(input: SubjectHopInput): Promise<SubjectHopOutcome> {
  let card: AgentCardV1 | null = null;
  try {
    const res = await input.fetch(input.cardUrl, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, refused: `its card at ${input.cardUrl} answered ${res.status}`, status: res.status };
    const text = await res.text();
    if (input.pinnedDigest) {
      const served = `0x${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      if (served !== input.pinnedDigest.toLowerCase()) return { ok: false, refused: `the card served at ${input.cardUrl} is not the one its name pins (atl:cardDigest ${input.pinnedDigest.slice(0, 12)}…, served ${served.slice(0, 12)}…)` };
    }
    card = JSON.parse(text) as AgentCardV1;
  } catch (e) {
    return { ok: false, refused: `its card at ${input.cardUrl} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const endpoint = a2aEndpointOf(card);
  if (!endpoint) return { ok: false, refused: 'its card publishes no A2A 1.0 endpoint this agent can ask' };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: subjectAskMessage(input.profile) } };
  let res: Response;
  try {
    res = await input.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${input.session}` },
      body: JSON.stringify(rpc),
    });
  } catch (e) {
    return { ok: false, endpoint, refused: `could not reach ${endpoint}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => null)) as { result?: { task?: TaskV1; message?: MessageV1 }; error?: { code: number; message: string } } | null;
  if (!body) return { ok: false, endpoint, refused: `${endpoint} answered ${res.status} with no JSON-RPC body`, status: res.status };
  if (body.error) return { ok: false, endpoint, refused: `${endpoint} answered ${body.error.code}: ${body.error.message}`, status: res.status };
  const task = body.result?.task;
  if (!task) return { ok: false, endpoint, refused: `${endpoint} answered with a message, not a task`, status: res.status };
  const envelope = subjectEnvelopeOf(task);
  if (envelope) return { ok: true, endpoint, task, envelope };
  const said = (task.status?.message?.parts ?? []).map((p) => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join(' ');
  return { ok: false, endpoint, task, refused: `${task.status?.state ?? 'unknown state'}${said ? `: ${said}` : ''}`, status: res.status };
}

// ── The answer, delivered (spec 374 §4) ──────────────────────────────────────────────────────────────
//
// When a routed ACT finishes at the subject's agent — its steward signed, or refused — the outcome is
// DELIVERED to the creditor's agent as a message under the same extension URI: a `SubjectAnswerV1` whose
// `inResponseTo` names the creditor's own correlation. The two payloads share a URI and are told apart
// by shape (an ask has `request`; an answer has `inResponseTo`), so one metadata key carries both halves
// of one conversation.

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/** The message that delivers a finished routed act's outcome to the creditor's agent. */
export function subjectAnswerMessage(answer: SubjectAnswerV1): MessageV1 {
  return {
    messageId: hex32(),
    role: 'ROLE_AGENT',
    parts: [{ text: answer.said ?? (answer.outcome === 'answer' ? 'Done.' : answer.outcome) }],
    extensions: [AP_SUBJECT_ASK_EXTENSION_URI],
    metadata: { [AP_SUBJECT_ASK_EXTENSION_URI]: answer },
  };
}

/** The delivered answer a received message carries, structurally checked; null when it carries none. */
export function subjectAnswerOf(message: Pick<MessageV1, 'metadata'>): { answer: SubjectAnswerV1 } | { errors: string[] } | null {
  const raw = message.metadata?.[AP_SUBJECT_ASK_EXTENSION_URI] as Partial<SubjectAnswerV1> | undefined;
  if (raw === undefined || raw === null || typeof raw !== 'object' || !('inResponseTo' in raw)) return null;
  const errors: string[] = [];
  if (raw.extension !== AP_SUBJECT_ASK_EXTENSION_URI) errors.push(`extension: expected ${AP_SUBJECT_ASK_EXTENSION_URI}`);
  if (raw.version !== 1) errors.push('version: expected 1');
  if (!isAddr(raw.agent)) errors.push('agent: an address');
  const r = raw.inResponseTo as Record<string, unknown> | undefined;
  if (!r || !['operationId', 'runRef', 'stepRef'].every((k) => typeof r[k] === 'string' && r[k])) errors.push('inResponseTo: { operationId, runRef, stepRef }');
  if (!['answer', 'refused', 'needs', 'error'].includes(String(raw.outcome))) errors.push('outcome: answer | refused | needs | error');
  if (!raw.run || typeof (raw.run as { runRef?: unknown }).runRef !== 'string') errors.push('run.runRef: required');
  return errors.length ? { errors } : { answer: raw as SubjectAnswerV1 };
}

// ── The hand-off (spec 376) ───────────────────────────────────────────────────────────────────────────
//
// One step, run elsewhere under a child mandate. Rides the one wire as a `SendMessage` whose metadata
// carries the hand-off profile; the specialist answers with the same `subject-answer` artifact a routed
// ask does, so the parent reads it with the same reader.

export function handoffMessage(h: HandoffV1): MessageV1 {
  return {
    messageId: hex32(),
    role: 'ROLE_USER',
    parts: [{ text: h.intent.goal }],
    extensions: [AP_HANDOFF_EXTENSION_URI],
    metadata: { [AP_HANDOFF_EXTENSION_URI]: h },
  };
}

export function handoffOf(message: Pick<MessageV1, 'metadata'>): { handoff: HandoffV1 } | { errors: string[] } | null {
  const raw = message.metadata?.[AP_HANDOFF_EXTENSION_URI];
  if (raw === undefined) return null;
  const v = validateHandoff(raw);
  return v.ok ? { handoff: v.handoff } : { errors: v.errors };
}
