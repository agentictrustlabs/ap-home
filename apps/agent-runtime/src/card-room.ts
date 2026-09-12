// THE CARD ROOM'S THREE ASKS OF A PERSON'S AGENT — and the coach service behind it.
//
// WHO TALKS TO WHOM. A card table addresses the seated person's OWN agent (alice.me) and nobody else:
// `poker.advise` mid-hand, `poker.record` when a hand she was dealt into ends, and `poker.review` when
// she asks how she has been playing. The person's agent GENERATES NOTHING for any of them. Advice and
// reviews are consulted from the coaching SERVICE her playbook names as the specialist for the skill
// (`{ capability: 'poker.advise', executor: 'bob-coach.svc' }`), under the STUDY GRANT she signed so the
// service may read her records; a record is a vault put. The service is the only thing on the hand's
// clock that calls a model, and it does so on its own account. The table never learns the service's
// endpoint; who coaches her is a fact about her, kept in her playbook and her grant.
//
// HER RECORDS, IN HER VAULT. `cardroom.hand` (each finished hand as her seat saw it, with the game's counts
// per player folded into running totals), `cardroom.style` (how she wants to play, in her words),
// `cardroom.read` (her own notes on players) and `cardroom.note` (the coach's notes, appended under the
// grant). The service holds none of them: it reads them at her vault under her grant, and writes exactly
// one thing back — a note — into HER cabinet. Firing the coach (revoking the grant) leaves nothing of hers
// behind; the vault refuses these record types on a service principal (`interactions-do.ts`).
//
// THE GRANT IS THE WHOLE OF THE SERVICE'S ACCESS. A vault-record-scope delegation: delegator the person,
// delegate the SERVICE (never the coach as a person), read on the study records, write on the note, a
// timestamp window, revocable on chain. Verified by the substrate (`verifyLiveDelegation`) at every
// consultation, exactly as an org wire is — missing, expired, revoked or mis-scoped, the person's agent
// refuses in one line and the table falls back to the house coach and says so.
//
// THE TEXAS HOLD'EM ONTOLOGY names all of this (skills.faithnet.io/ontology/texas-holdem): th:CoachService,
// th:StudyGrant, th:Consultation, th:ReviewRequest, th:HandReview, th:HandRecord, th:StyleRecord,
// th:PlayerRead, th:CoachNote, th:ConsultOutcome. The Home's vault bindings are in
// `packages/ontology/src/vault-records.ts` (apctx:CardRoom*).
//
// GAME-AGNOSTIC BY CONSTRUCTION, like playbook memory: a skill family is the first segment (`poker`,
// `canasta`), the act is the last (`advise`, `record`, `review`), and the view is the game's own.
import { VAULT_RECORD_SCOPE_ENFORCER, decodeVaultRecordScopeTerms, vaultRecordScopeAllows, type EnforcerAddressMap } from '@agenticprimitives/delegation';
import type { Hex } from '@agenticprimitives/types';
import { verifyOrgWire, type IncomingWire, type OrgWireChecks } from './org-wire.js';
import { foldObservation, observationOf, rememberedFor, type PlaybookMemoryV1 } from './playbook-memory.js';

/** The person's study records, by type. Read by the service under the grant; written as the table says. */
export const HAND_RECORD = 'cardroom.hand';
export const STYLE_RECORD = 'cardroom.style';
export const READ_RECORD = 'cardroom.read';
export const NOTE_RECORD = 'cardroom.note';
/** What a coach service keeps about a client in ITS OWN vault: pointers, never records. */
export const CLIENT_RECORD = 'cardroom.client';

export const STUDY_READS = [HAND_RECORD, STYLE_RECORD, READ_RECORD, NOTE_RECORD] as const;
export const STUDY_APPENDS = [NOTE_RECORD] as const;
/** The MCP server id the vault-record-scope caveat binds (`hasScopedAccess` pins the same constant). */
export const STUDY_SERVER = 'demo-mcp';

/** How many finished hands are kept in full. Every hand folds into the counts; the most recent stay whole
 *  for a review ("the last sixty" is a pattern; the counts carry the rest). */
export const HANDS_KEPT = 60;
/** How many coach notes are kept. A note is two sentences; a hundred is a season. */
export const NOTES_KEPT = 100;
/**
 * How long the person's agent gives the service before the refusal that lets the house answer.
 *
 * Measured 2026-09-12 (Haiku, prompt cached, study prefetched, standing from the grant, the run record
 * deferred): a COLD consultation is ~12 s as the person's agent sees it — the coach's playbook read (~1.6 s),
 * the model (~5–7 s), the gates and the hop; warm, 6–10 s. Fifteen seconds is the cold path plus its
 * variance; below that a slow-but-fine coach would be thrown away for the house line, which is the one way
 * a timeout loses capability. The table's own advice budget is 35 s, so the hop back is never the bound.
 */
export const CONSULT_TIMEOUT_MS = 15_000;

export type CardRoomAct = 'advise' | 'record' | 'review';

/** `poker.advise` → advise; `canasta.record` → record; anything else → null (not the card room's). */
export function cardRoomActOf(skill: string | null | undefined): CardRoomAct | null {
  const m = /\.(advise|record|review)$/i.exec(String(skill ?? '').trim());
  return m ? (m[1]!.toLowerCase() as CardRoomAct) : null;
}

/** The grant as it travels in the consultation's material: the person's agent fetched it from her own
 *  object (`internal.studygrant.wire`) and presents it beside the table's payload. */
export interface StudyGrantWire { wire: IncomingWire; hash: string }

/** What a verified grant lets the service do, for one consultation. */
export interface StudyAccess {
  /** The person whose records these are — the grant's delegator. */
  owner: string;
  /** The service — the grant's delegate. */
  delegate: string;
  hash: string;
  reads: string[];
  appends: string[];
}

export function studyGrantOf(material: Record<string, unknown> | null | undefined): StudyGrantWire | null {
  const g = material?.grant as { wire?: unknown; hash?: unknown } | undefined;
  if (!g || typeof g !== 'object' || !g.wire || typeof g.wire !== 'object') return null;
  const w = g.wire as Partial<IncomingWire>;
  if (typeof w.delegator !== 'string' || typeof w.delegate !== 'string' || !Array.isArray(w.caveats) || typeof w.signature !== 'string') return null;
  return { wire: w as IncomingWire, hash: typeof g.hash === 'string' ? g.hash : '' };
}

/**
 * VERIFY A STUDY GRANT for one consultation: from THIS person, to THIS service, scoped to her study
 * records, live and genuinely signed.
 *
 * Shape and scope are decided here (app policy, the same split as `hasScopedAccess`): the caveat must be
 * a vault-record-scope caveat, it must read `cardroom.hand` at least, and it may write nothing but
 * `cardroom.note`. Liveness — signature, revocation, the timestamp window — is the substrate's
 * (`verifyLiveDelegation`, through `verifyOrgWire`). The reason is returned because the PERSON reads it:
 * "your coach's grant is revoked" is what lets her fix it, and nothing here is a probe surface — the
 * grant is hers, presented by her own agent.
 */
export async function verifyStudyGrant(input: {
  grant: StudyGrantWire | null;
  /** The person whose agent is consulting — the asker of the service's run. */
  delegator: string;
  /** The service being consulted — the addressee of the service's run. */
  delegate: string;
  enforcers: EnforcerAddressMap;
  checks: OrgWireChecks;
  now?: number;
}): Promise<{ ok: true; access: StudyAccess } | { ok: false; reason: string }> {
  const g = input.grant;
  if (!g) return { ok: false, reason: 'no study grant was presented' };
  const w = g.wire;
  if (w.delegator.toLowerCase() !== input.delegator.toLowerCase()) return { ok: false, reason: 'the study grant was not signed by the person being advised' };
  if (w.delegate.toLowerCase() !== input.delegate.toLowerCase()) return { ok: false, reason: 'the study grant names a different coach' };
  const cav = (w.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
  if (!cav?.terms) return { ok: false, reason: 'the study grant carries no record scope' };
  let grants;
  try { grants = decodeVaultRecordScopeTerms(cav.terms as Hex); } catch { return { ok: false, reason: 'the study grant’s scope is undecodable' }; }
  if (grants.length === 0) return { ok: false, reason: 'the study grant scopes nothing' };
  // `vaultRecordScopeAllows` answers TRUE for an empty scope set; the emptiness test above is what keeps
  // "no scope" from reading as "every scope" (the same NO SCOPE ⇒ NO rule as `hasScopedAccess`).
  const reads = STUDY_READS.filter((r) => vaultRecordScopeAllows(grants, { server: STUDY_SERVER, resource: `vault:${r}`, op: 'read' }));
  const appends = STUDY_APPENDS.filter((r) => vaultRecordScopeAllows(grants, { server: STUDY_SERVER, resource: `vault:${r}`, op: 'write' }));
  if (!reads.includes(HAND_RECORD)) return { ok: false, reason: 'the study grant does not read her hands' };
  // NOTHING BUT THE NOTE IS WRITABLE. A grant that let the coach write her hands or her style would let
  // it rewrite the evidence it is judged against; such a grant is refused whole, not narrowed.
  const writesElse = grants.some((gr) => gr.ops.includes('write') || gr.ops.includes('delete')
    ? gr.resources.some((r) => r !== `vault:${NOTE_RECORD}`) : false);
  if (writesElse) return { ok: false, reason: 'the study grant writes more than the coach’s notes' };
  const live = await verifyOrgWire({ wire: w, expectedDelegator: input.delegator, expectedDelegate: input.delegate as `0x${string}`, enforcers: input.enforcers, checks: input.checks, ...(input.now ? { now: input.now } : {}) });
  if (!live) return { ok: false, reason: 'the study grant is expired, revoked or not genuinely signed' };
  return { ok: true, access: { owner: w.delegator.toLowerCase(), delegate: w.delegate.toLowerCase(), hash: g.hash, reads, appends } };
}

// ── Her hand record ──────────────────────────────────────────────────────────────────────────────────

/** One finished hand, as her seat saw it. The view is the game's own and is kept opaque. */
export interface HandEntryV1 {
  handNo: number;
  table: string;
  seat: number;
  at: string;
  /** The final view for her seat — her cards, the board, the action, the result. Never another seat's. */
  view: unknown;
  /** Her net for the hand, when the observation says (the `you` subject's `netChips`). */
  net?: number;
}

export interface HandRecordV1 {
  type: 'ap.cardroom-hand.v1';
  family: string;
  /** Every hand ever recorded — the counts carry them all. */
  hands: number;
  /** The most recent `HANDS_KEPT`, whole, newest last. */
  recent: HandEntryV1[];
  /** The counts per player, folded from every hand's observation (`playbook-memory`'s ledger, reused). */
  memory: PlaybookMemoryV1;
  updatedAt: string;
}

export function isHandRecord(x: unknown): x is HandRecordV1 {
  return !!x && typeof x === 'object' && (x as { type?: unknown }).type === 'ap.cardroom-hand.v1' && Array.isArray((x as { recent?: unknown }).recent);
}

/**
 * A FINISHED HAND, INTO HER RECORD. No model: the view is kept as sent, the counts are added. Everything
 * is worth recording, because the coach decides later what it means — a record that asked a model what
 * was "worth remembering" kept nothing (2026-09-11), and a model on this hop is a bill at every showdown.
 */
export function recordHand(prev: unknown, skill: string, input: unknown, now = new Date()): HandRecordV1 | null {
  const inp = (input && typeof input === 'object' ? input : null) as { handNo?: unknown; tableId?: unknown; seat?: unknown; view?: unknown; observation?: unknown } | null;
  if (!inp || inp.view === undefined) return null;
  const family = (skill.split('.')[0] ?? skill).toLowerCase();
  const base: HandRecordV1 = isHandRecord(prev) && prev.family === family
    ? prev
    : { type: 'ap.cardroom-hand.v1', family, hands: 0, recent: [], memory: { type: 'ap.playbook-memory.v1', family, rounds: 0, subjects: {}, updatedAt: now.toISOString() }, updatedAt: now.toISOString() };
  const obs = observationOf(inp);
  const you = obs ? Object.values(obs.subjects).find((s) => s.you) : undefined;
  const entry: HandEntryV1 = {
    handNo: Number(inp.handNo ?? 0) || 0,
    table: String(inp.tableId ?? ''),
    seat: Number(inp.seat ?? 0) || 0,
    at: now.toISOString(),
    view: inp.view,
    ...(you && typeof you.counters.netChips === 'number' ? { net: you.counters.netChips } : {}),
  };
  // The same hand reported twice (a retry) is recorded once: the table names the hand and the seat.
  const dup = base.recent.some((h) => h.table === entry.table && h.handNo === entry.handNo && h.seat === entry.seat && entry.handNo > 0);
  if (dup) return base;
  return {
    ...base,
    hands: base.hands + 1,
    recent: [...base.recent, entry].slice(-HANDS_KEPT),
    memory: obs ? foldObservation(base.memory, family, obs, now) : base.memory,
    updatedAt: now.toISOString(),
  };
}

// ── Her style, her reads, the coach's notes ──────────────────────────────────────────────────────────

export interface StyleRecordV1 { type: 'ap.cardroom-style.v1'; rules: string[]; updatedAt: string }
export interface PlayerReadV1 { type: 'ap.cardroom-read.v1'; reads: Array<{ about: string; note: string; at: string }>; updatedAt: string }
export interface CoachNoteV1 { by: string; at: string; text: string; hand?: number; scope?: string }
export interface CoachNotesV1 { type: 'ap.cardroom-note.v1'; entries: CoachNoteV1[]; updatedAt: string }

export function styleRulesOf(x: unknown): string[] {
  const r = (x as { rules?: unknown } | null)?.rules;
  return Array.isArray(r) ? r.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 40) : [];
}

export function readsOf(x: unknown): Array<{ about: string; note: string }> {
  const r = (x as { reads?: unknown } | null)?.reads;
  return Array.isArray(r) ? r.filter((e): e is { about: string; note: string } => !!e && typeof e === 'object' && typeof (e as { about?: unknown }).about === 'string' && typeof (e as { note?: unknown }).note === 'string').slice(0, 40) : [];
}

export function notesOf(x: unknown): CoachNoteV1[] {
  const e = (x as { entries?: unknown } | null)?.entries;
  return Array.isArray(e) ? e.filter((n): n is CoachNoteV1 => !!n && typeof n === 'object' && typeof (n as { text?: unknown }).text === 'string') : [];
}

/** Append one note; read-modify-write by the caller, under the grant's append scope. */
export function appendNote(prev: unknown, note: CoachNoteV1, now = new Date()): CoachNotesV1 {
  const entries = [...notesOf(prev), note].slice(-NOTES_KEPT);
  return { type: 'ap.cardroom-note.v1', entries, updatedAt: now.toISOString() };
}

// ── What the coach is handed ─────────────────────────────────────────────────────────────────────────

/** The study, read for one consultation: only what the grant covers, only what the spot needs. */
export interface Study {
  owner: string;
  style: string[];
  /** The players present in THIS material, with their counts and rates, from her hand record. */
  remembered: ReturnType<typeof rememberedFor>;
  reads: Array<{ about: string; note: string }>;
  /** The coach's most recent notes, newest last. */
  notes: CoachNoteV1[];
  /** How many hands her record holds. */
  hands: number;
  /** For a review: the recent hands themselves. */
  recent?: HandEntryV1[];
}

export function studyFrom(input: { access: StudyAccess; hand: unknown; style: unknown; read: unknown; note: unknown; material: unknown; review?: boolean }): Study {
  const hand = isHandRecord(input.hand) ? input.hand : null;
  const notes = input.access.reads.includes(NOTE_RECORD) ? notesOf(input.note).slice(-6) : [];
  return {
    owner: input.access.owner,
    style: input.access.reads.includes(STYLE_RECORD) ? styleRulesOf(input.style) : [],
    remembered: hand ? rememberedFor(hand.memory, input.material) : [],
    reads: input.access.reads.includes(READ_RECORD) ? readsOf(input.read) : [],
    notes,
    hands: hand?.hands ?? 0,
    ...(input.review && hand ? { recent: hand.recent } : {}),
  };
}

/** A review's scope, from the question: a day, a player, one hand, or the leaks over the recent hands. */
export function reviewScopeOf(question: string, recent: HandEntryV1[], now = new Date()): { hands: HandEntryV1[]; label: string } {
  const q = question.toLowerCase();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const day = days.findIndex((d) => q.includes(d));
  if (day >= 0) {
    const hands = recent.filter((h) => new Date(h.at).getDay() === day);
    return { hands, label: `${days[day]![0]!.toUpperCase()}${days[day]!.slice(1)}, ${hands.length} hand${hands.length === 1 ? '' : 's'}` };
  }
  if (/\b(today|tonight|this session|last night|yesterday)\b/.test(q)) {
    const since = now.getTime() - (/(last night|yesterday)/.test(q) ? 36 : 12) * 3600_000;
    const hands = recent.filter((h) => new Date(h.at).getTime() >= since);
    return { hands, label: `${/(last night|yesterday)/.test(q) ? 'last night' : 'this session'}, ${hands.length} hand${hands.length === 1 ? '' : 's'}` };
  }
  if (/\b(that|last|previous) (hand|one)\b/.test(q)) {
    const hands = recent.slice(-1);
    return { hands, label: hands.length ? `hand ${hands[0]!.handNo}` : 'no hand' };
  }
  return { hands: recent, label: `the last ${recent.length} hand${recent.length === 1 ? '' : 's'}` };
}

// ── The turn itself ──────────────────────────────────────────────────────────────────────────────────

/** The Worker's seams, so the turn can be held to its invariants with fakes. */
export interface CardRoomDeps {
  nameOf: (address: string) => Promise<string | null>;
  resolveName: (name: string) => Promise<string | null>;
  readRecord: (owner: string, recordType: string) => Promise<unknown>;
  writeRecord: (owner: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  /** The addressee's playbook specialists (`{ capability, executor }`), or null when it has no playbook. */
  specialistsOf: (agent: string) => Promise<ReadonlyArray<{ capability: string; executor: string }> | null>;
  studyGrantWire: (person: string, coach: string) => Promise<{ wire: unknown; hash: string; delegate: string } | null>;
  verify: (grant: StudyGrantWire, delegator: string, delegate: string) => Promise<{ ok: true; access: StudyAccess } | { ok: false; reason: string }>;
  /** The consultation: the person's agent asks the coach, in-process, presenting the grant in the material. */
  consult: (input: { agent: string; addressee: string; ask: string; runRef: string; material: Record<string, unknown> }) => Promise<{ reply: { kind: string; text?: string; error?: string } }>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface CardRoomAskInput {
  /** The asker: the card room (as the house) for a table's ask; the person's agent for a consultation. */
  agent: string;
  /** The addressee: the person's agent for a table's ask; the coach service for a consultation. */
  addressee: string;
  ask: string;
  runRef: string;
  skill: string;
  act: CardRoomAct;
  /** Whether the addressee's card advertises the skill. Unadvertised ⇒ refused; never planned. */
  advertised: boolean;
  material: Record<string, unknown> | null;
}

export type CardRoomTurn =
  | { kind: 'answer' | 'refused'; text: string; extra: Record<string, unknown> }
  | { study: StudyAccess };

/**
 * ONE CARD-ROOM ASK, decided before the harness:
 *
 *  · a GRANT in the material ⇒ this is the coach service, consulted by the person's own agent. Verify the
 *    grant (delegator = the asker, delegate = this service, scoped to her study records, live on chain) and
 *    hand it to the harness, which runs `playbook.answer` under it. A grant that fails is a one-line refusal.
 *  · `record`, no grant ⇒ the person's own agent puts the hand into her vault. No model.
 *  · `advise` / `review`, no grant ⇒ the person's own agent consults the specialist its playbook names for
 *    the skill — a SERVICE, by name — presenting her study grant, and returns the coach's words in the
 *    coach's name (`source`). No specialist, no grant, no answer in time ⇒ refuse in one line; the table
 *    falls back to the house and says so.
 *
 * Nothing here reaches a planner or a model. A person's agent's `poker.advise` costs no tokens; a hand's
 * record costs no tokens; the coach is never messaged at a hand's end.
 */
export async function cardRoomTurn(deps: CardRoomDeps, input: CardRoomAskInput): Promise<CardRoomTurn> {
  const t0 = Date.now();
  const me = input.addressee.toLowerCase();
  const myName = (await deps.nameOf(me).catch(() => null)) ?? me;
  const log = deps.log ?? ((line: string) => console.log(line));
  const done = (kind: 'answer' | 'refused', text: string, extra: Record<string, unknown> = {}): CardRoomTurn => {
    log(`[card-room] ${myName} ${input.skill} → ${kind} in ${Date.now() - t0}ms${extra.source ? ` · via ${String(extra.source)}` : ''}${kind === 'refused' ? ` · ${text}` : ''}`);
    return { kind, text, extra };
  };
  if (!input.advertised) return done('refused', `${myName} does not advertise ${input.skill}`);

  // ── THE COACH, under a grant ──
  const grant = studyGrantOf(input.material);
  if (grant) {
    if (input.act === 'record') return done('refused', 'a hand is recorded by the person\'s own agent, never by a coach');
    const verified = await deps.verify(grant, input.agent, input.addressee);
    if (!verified.ok) return done('refused', verified.reason);
    log(`[card-room] ${myName} ${input.skill} · study grant from ${verified.access.owner} verified in ${Date.now() - t0}ms · reads ${verified.access.reads.length} appends ${verified.access.appends.length}`);
    return { study: verified.access };
  }

  // ── THE PERSON'S OWN AGENT ──
  if (input.act === 'record') {
    const prev = await deps.readRecord(me, HAND_RECORD).catch(() => null);
    const next = recordHand(prev, input.skill, input.material?.input);
    if (!next) return done('refused', 'the message carried no hand to record');
    const wrote = await deps.writeRecord(me, HAND_RECORD, next).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    if (!wrote.ok) return done('refused', `the hand could not be recorded: ${wrote.error ?? 'refused'}`);
    return done('answer', JSON.stringify({ say: `Recorded hand ${next.recent[next.recent.length - 1]?.handNo ?? next.hands} — ${next.hands} on record.` }), { hands: next.hands });
  }
  // advise / review: consult the specialist the playbook names — a coaching SERVICE, by name. A review
  // goes to the same coach as advice when no specialist names it separately.
  const specialists = await deps.specialistsOf(me).catch(() => null);
  const specialist = specialists?.find((s) => s.capability.toLowerCase() === input.skill.toLowerCase())
    ?? (input.act === 'review' ? specialists?.find((s) => s.capability.toLowerCase() === input.skill.replace(/\.review$/i, '.advise').toLowerCase()) : undefined);
  if (!specialist) return done('refused', `no coach is named for ${input.skill}; the house coach will answer`);
  const coach = specialist.executor.toLowerCase();
  if (!/\.svc$/.test(coach)) return done('refused', `${coach} is not a coaching service; a coach is a service, never a person`);
  const [coachAddr, studyGrant] = await Promise.all([deps.resolveName(coach).catch(() => null), deps.studyGrantWire(me, coach).catch(() => null)]);
  if (!coachAddr) return done('refused', `${coach} does not resolve to an agent`);
  if (!studyGrant) return done('refused', `no study grant for ${coach}; the house coach will answer`);
  if (studyGrant.delegate.toLowerCase() !== coachAddr.toLowerCase()) return done('refused', `the study grant for ${coach} names a different agent`);
  const tConsult = Date.now();
  const timeoutMs = deps.timeoutMs ?? CONSULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consulted = await Promise.race([
    deps.consult({
      agent: input.addressee, addressee: coachAddr, ask: input.ask, runRef: `${input.runRef}/consult`,
      // THE SAME PAYLOAD, UNCHANGED, with the grant beside it. Her records are not fetched and pasted in: the
      // coach reads them itself, under the grant, at her vault — forwarding record bodies would make this
      // agent the confused deputy, a copy travelling on its say-so rather than under her grant.
      material: { ...(input.material ?? {}), grant: { wire: studyGrant.wire, hash: studyGrant.hash }, onBehalfOf: myName },
    }).then((r) => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
    new Promise<{ ok: false; error: string }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `${coach} did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!consulted.ok) return done('refused', consulted.error);
  const reply = consulted.r.reply;
  const text = String(reply.text ?? '').trim();
  if (reply.kind !== 'answer' || !text) return done('refused', `${coach}: ${text || reply.error || 'no answer'}`);
  // The coach's words, in the coach's name. The answer is the JSON the card room decodes; `source` is added
  // so the screen can say "Bob, via alice.me", and nothing else is touched — nothing added, nothing softened.
  let decoded: Record<string, unknown> | null = null;
  try { const j: unknown = JSON.parse(text); decoded = j && typeof j === 'object' ? (j as Record<string, unknown>) : null; } catch { decoded = null; }
  const out = decoded ? { ...decoded, source: coach } : { say: text, source: coach };
  log(`[card-room] ${myName} ${input.skill} · consulted ${coach} in ${Date.now() - tConsult}ms`);
  return done('answer', JSON.stringify(out), { source: coach, consulted: { coach, runRef: `${input.runRef}/consult` } });
}
