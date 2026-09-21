// ATTENTION, NOT NOTIFICATIONS — spec 398 §5.5 (APUX-012). The filter model on /messages: NEEDS MY DECISION · NEEDS MY
// INPUT · BLOCKED · FAILED ROUTINE · FINISHED ARTIFACT · UNREAD. An unread message is not a decision; a decision is
// not an exception; an artifact that finished is neither. One durable record per decision however it was delivered
// (393): a case in the inbox, a run parked on a signature, an allocation waiting for a commitment — each is ONE card
// with ONE action set, resolved where it is signed. Pure: it takes what the clients return and sorts it into the six;
// it fetches nothing and decides nothing about authority.
import { assembleToday, type TodayInputs, type TodayItem } from './today';

export type AttentionFilter = 'decision' | 'input' | 'blocked' | 'failed-routine' | 'artifact' | 'unread';

export const ATTENTION_FILTERS: ReadonlyArray<{ id: AttentionFilter; label: string; hint: string }> = [
  { id: 'decision', label: 'Needs my decision', hint: 'a signature, an approval you were named for, a commitment waiting on you' },
  { id: 'input', label: 'Needs my input', hint: 'your agent stopped to ask you something' },
  { id: 'blocked', label: 'Blocked', hint: 'waiting on someone else — a commitment, a steward' },
  { id: 'failed-routine', label: 'Failed routine', hint: 'a scheduled or hooked ask whose last firing failed' },
  { id: 'artifact', label: 'Finished artifact', hint: 'what recent runs left in the Library' },
  { id: 'unread', label: 'Unread', hint: 'messages you have not opened — not decisions' },
];

/** An inbox CASE as the Messages view holds it (fabric `InteractionCaseV1`, the fields this model reads). */
export interface AttentionCase { id: string; kind: string; subject: string; state: string; requester: string; responder: string; updatedAt: string; title?: string; summary?: string }
/** A direct-message bucket with its unread count (the rail's row). */
export interface AttentionDm { key: string; title: string; unread: number; lastEventAt: string; preview?: string }

export interface AttentionInputs extends TodayInputs {
  /** Cases in the inbox; those pending on ME (responder) are decisions. */
  cases: ReadonlyArray<AttentionCase>;
  /** Whose inbox this is (lowercased CAIP-10 or address) — a case I requested is not my decision. */
  me: string;
  dms: ReadonlyArray<AttentionDm>;
}

export interface AttentionItem extends TodayItem { filter: AttentionFilter; caseId?: string; dmKey?: string }

const PENDING_CASE_STATES = new Set(['submitted', 'triaged']);
const same = (a: string, b: string): boolean => a.toLowerCase().endsWith(b.toLowerCase().replace(/^.*:/, ''));

export function assembleAttention(input: AttentionInputs): Record<AttentionFilter, AttentionItem[]> {
  const today = assembleToday(input);
  const out: Record<AttentionFilter, AttentionItem[]> = { decision: [], input: [], blocked: [], 'failed-routine': [], artifact: [], unread: [] };
  // decisions: everything Today calls a decision, plus the inbox cases pending on me
  for (const d of today.decisions) out.decision.push({ ...d, filter: 'decision' });
  for (const c of input.cases) {
    if (!PENDING_CASE_STATES.has(c.state)) continue;
    if (!same(c.responder, input.me)) continue;   // I asked; someone else decides
    out.decision.push({
      id: `case:${c.id}`, title: c.title ?? c.subject, detail: c.summary ?? `${c.kind} · from ${c.requester.slice(0, 12)}…`,
      state: { state: 'awaiting-approval', effectUncertain: false }, native: c.kind, at: Date.parse(c.updatedAt), filter: 'decision', caseId: c.id,
    });
  }
  // input vs blocked: an active goal waiting on ME is input; waiting on someone else is blocked
  for (const a of today.active) {
    if (a.state?.state === 'awaiting-input') out.input.push({ ...a, filter: 'input' });
    else if (a.state?.state === 'blocked') out.blocked.push({ ...a, filter: 'blocked' });
  }
  for (const e of today.exceptions) out['failed-routine'].push({ ...e, filter: 'failed-routine' });
  for (const a of today.artifacts) out.artifact.push({ ...a, filter: 'artifact' });
  for (const dm of input.dms) {
    if (dm.unread <= 0) continue;
    out.unread.push({ id: `dm:${dm.key}`, title: dm.title, ...(dm.preview ? { detail: dm.preview } : {}), at: Date.parse(dm.lastEventAt), filter: 'unread', dmKey: dm.key });
  }
  for (const k of Object.keys(out) as AttentionFilter[]) out[k].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return out;
}

/** The chip counts, in the model's order. */
export function attentionCounts(a: Record<AttentionFilter, AttentionItem[]>): Array<{ id: AttentionFilter; label: string; count: number }> {
  return ATTENTION_FILTERS.map((f) => ({ id: f.id, label: f.label, count: a[f.id].length }));
}

// ─── The inbox's THREE groups (the UX of 2026-09-20) ───────────────────────────────────────────────────────────────
// Six filters is the MODEL (each a different thing); it is not the SHAPE of the screen. An inbox shows what needs
// you first, folds what is merely waiting or finished, and treats "unread" as a filter on the conversations, not as
// a bucket beside them. So the rail renders three groups from the six: NEEDS YOU (decision + input — you act, now),
// WAITING (blocked + failed routine — you wait, or you look), FINISHED (artifacts — you may look). Unread stays a
// filter. A group with nothing in it does not appear; a count of zero is never shown.
export type AttentionGroupId = 'needs-you' | 'waiting' | 'finished';
export interface AttentionGroup { id: AttentionGroupId; label: string; hint: string; items: AttentionItem[]; /** Open by default: only what needs you. */ open: boolean }

export function attentionGroups(a: Record<AttentionFilter, AttentionItem[]>): AttentionGroup[] {
  const byTime = (xs: AttentionItem[]) => [...xs].sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
  const groups: AttentionGroup[] = [
    { id: 'needs-you', label: 'Needs you', hint: 'a signature, an approval, a question your agent stopped to ask', items: byTime([...a.decision, ...a.input]), open: true },
    { id: 'waiting', label: 'Waiting', hint: 'on someone else, or a routine that failed its last run', items: byTime([...a.blocked, ...a['failed-routine']]), open: false },
    { id: 'finished', label: 'Finished', hint: 'what recent runs left in the Library', items: byTime(a.artifact), open: false },
  ];
  return groups.filter((g) => g.items.length > 0);
}
/** The number that needs the person's act — the one figure an inbox may badge. */
export const needsYouCount = (a: Record<AttentionFilter, AttentionItem[]>): number => a.decision.length + a.input.length;
