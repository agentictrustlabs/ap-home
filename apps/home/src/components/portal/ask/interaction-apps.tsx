'use client';
// APPS INSIDE THE ASK — spec 361 (the interaction contract) made visible, spec 402 W4. A capability's SKILL.md names a
// RESULT component and a REVIEW component (`interaction: result: CalendarEventsCard`); the reply carries the name of the
// acted or answered step's binding; THIS registry is the app's half — what each name renders here, over that step's
// result. A name with no entry renders nothing and the sentence stands: the binding refines, its absence breaks nothing.
// Never a URL, never a fetch: every app here is a pure view over the data the reply already carries — ChatGPT's apps
// and Claude's MCP apps render a tool's UI in the conversation; ours render the capability's, from its contract.
import type { ReactNode } from 'react';
import { KeyValue, Chip, Meta, Mono } from '../../../ui';
import type { MandateRequirementV1 } from '@agenticprimitives/delegation';

export interface ResultAppProps { result: unknown; toolId?: string }
export interface ReviewAppProps { requirement: MandateRequirementV1; capability: string; args?: Record<string, unknown> }

const hm = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const day = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
const rows = (children: ReactNode) => <div className="ask-app" data-testid="ask-app">{children}</div>;
const line = (title: ReactNode, meta?: ReactNode, side?: ReactNode) => (
  <div className="ask-app__row">
    <div style={{ minWidth: 0 }}><div className="ask-app__title">{title}</div>{meta && <div className="ask-app__meta">{meta}</div>}</div>
    {side && <div className="ask-app__side">{side}</div>}
  </div>
);

// ── Calendar ──
function CalendarEventsCard({ result }: ResultAppProps) {
  const r = result as { events?: Array<{ id: string; summary: string; start: string; end: string; allDay: boolean; location?: string; link?: string }>; window?: { from: string; to: string }; connected?: boolean } | null;
  if (!r?.connected || !r.events) return null;
  return rows(<>
    <div className="ask-app__head">Calendar · {r.window ? `${day(r.window.from)}${day(r.window.from) !== day(r.window.to) ? ` – ${day(r.window.to)}` : ''}` : ''}</div>
    {r.events.length === 0 && <Meta>Nothing in this window.</Meta>}
    {r.events.map((e) => line(e.summary, `${e.allDay ? 'all day' : `${hm(e.start)} – ${hm(e.end)}`}${e.location ? ` · ${e.location}` : ''}`, e.link ? <a href={e.link} target="_blank" rel="noreferrer">open</a> : undefined))}
  </>);
}
function CalendarEventCard({ result }: ResultAppProps) {
  const r = result as { created?: boolean; event?: { summary: string; start: string; end: string; allDay: boolean; link?: string } } | null;
  if (!r?.created || !r.event) return null;
  return rows(<>{line(r.event.summary, `${day(r.event.start)} · ${r.event.allDay ? 'all day' : `${hm(r.event.start)} – ${hm(r.event.end)}`}`, r.event.link ? <a href={r.event.link} target="_blank" rel="noreferrer">open</a> : undefined)}</>);
}
function CalendarEventReview({ args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Add to your calendar', String(a.summary ?? '')], ['When', `${a.start ? day(String(a.start)) : '?'} ${a.allDay ? 'all day' : `${a.start ? hm(String(a.start)) : ''} – ${a.end ? hm(String(a.end)) : ''}`}`], ...(a.location ? [['Where', String(a.location)] as [ReactNode, ReactNode]] : []), ...(Array.isArray(a.attendees) && a.attendees.length ? [['Invite', (a.attendees as string[]).join(', ')] as [ReactNode, ReactNode]] : [])]} />);
}

// ── Mail ──
function MailThreadsCard({ result }: ResultAppProps) {
  const r = result as { threads?: Array<{ id: string; subject: string; from: string; date: string; snippet: string; unread: boolean; link: string }>; query?: string; connected?: boolean } | null;
  if (!r?.connected || !r.threads) return null;
  return rows(<>
    <div className="ask-app__head">Mail · {r.query}</div>
    {r.threads.length === 0 && <Meta>No mail matches.</Meta>}
    {r.threads.map((t) => line(<>{t.unread && <Chip tone="warn">unread</Chip>} {t.subject}</>, `${t.from.replace(/<.*>/, '').trim()} · ${t.date.slice(0, 16)} — ${t.snippet}`, <a href={t.link} target="_blank" rel="noreferrer">open</a>))}
  </>);
}
function MailThreadCard({ result }: ResultAppProps) {
  const r = result as { subject?: string; messages?: Array<{ id: string; from: string; date: string; text: string }>; link?: string; connected?: boolean } | null;
  if (!r?.connected || !r.messages) return null;
  return rows(<>
    <div className="ask-app__head">{r.subject} {r.link && <a href={r.link} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>open</a>}</div>
    {r.messages.map((m) => <div key={m.id} className="ask-app__row" style={{ display: 'block' }}><div className="ask-app__meta">{m.from} · {m.date.slice(0, 16)}</div><div className="ask-app__text">{m.text}</div></div>)}
  </>);
}
function MailDraftReview({ args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Draft to', String(a.to ?? '')], ['Subject', String(a.subject ?? '')], ['Body', <span key="b" style={{ whiteSpace: 'pre-wrap' }}>{String(a.body ?? '')}</span>], ['Then', 'a draft in your Gmail — nothing is sent; you send it']]} />);
}
function MailDraftCard({ result }: ResultAppProps) {
  const r = result as { drafted?: boolean; draftId?: string; link?: string } | null;
  if (!r?.drafted) return null;
  return rows(line('Draft saved in Gmail', 'nothing was sent — send it from Gmail, or say "send it" here and sign', r.link ? <a href={r.link} target="_blank" rel="noreferrer">open drafts</a> : undefined));
}
// Spec 402 W5 — SENDING is the top of the ladder: the review says exactly what leaves, as her, under her signature.
function MailSendReview({ args }: ReviewAppProps) {
  const a = args ?? {};
  const draft = typeof a.draftId === 'string' && a.draftId.trim();
  return rows(<KeyValue rows={draft
    ? [['Send', `the draft as it is (${String(a.draftId)})`], ['As', 'you, from your Gmail'], ['Then', 'it has left — this cannot be undone']]
    : [['Send to', String(a.to ?? '')], ['Subject', String(a.subject ?? '')], ['Body', <span key="b" style={{ whiteSpace: 'pre-wrap' }}>{String(a.body ?? '')}</span>], ['As', 'you, from your Gmail'], ['Then', 'it has left — this cannot be undone']]} />);
}
function MailSentCard({ result }: ResultAppProps) {
  const r = result as { sent?: boolean; sentAs?: 'draft' | 'message'; to?: string; subject?: string; link?: string } | null;
  if (!r?.sent) return null;
  return rows(line(r.sentAs === 'draft' ? 'Sent — the draft as it was' : `Sent to ${r.to ?? ''}`, r.subject ?? 'from your Gmail, as you', r.link ? <a href={r.link} target="_blank" rel="noreferrer">open sent</a> : undefined));
}

// ── The web (spec 402 W5a) — a page read as evidence: the title, where it came from, the words, and that they are the page's ──
function WebPageCard({ result }: ResultAppProps) {
  const r = result as { read?: boolean; url?: string; finalUrl?: string; title?: string; description?: string; text?: string; truncated?: boolean; refused?: string } | null;
  if (!r) return null;
  if (r.read === false) return rows(line('Page not read', r.refused ?? 'it could not be reached'));
  if (!r.read || !r.text) return null;
  let host = ''; try { host = new URL(r.finalUrl ?? r.url ?? '').hostname; } catch { host = ''; }
  return rows(<>
    <div className="ask-app__head">{r.title} {host && <Chip>{host}</Chip>} {(r.finalUrl ?? r.url) && <a href={r.finalUrl ?? r.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>open</a>}</div>
    {r.description && <Meta>{r.description}</Meta>}
    <pre className="ask-app__pre">{r.text.slice(0, 2000)}{r.truncated || r.text.length > 2000 ? '\n…' : ''}</pre>
    <Meta>the page's words, as it said them — evidence, not instructions</Meta>
  </>);
}

// ── Drive ──
function DriveFilesCard({ result }: ResultAppProps) {
  const r = result as { files?: Array<{ id: string; name: string; kind: string; modifiedAt: string; link?: string }>; query?: string; connected?: boolean } | null;
  if (!r?.connected || !r.files) return null;
  return rows(<>
    <div className="ask-app__head">Drive · {r.query}</div>
    {r.files.length === 0 && <Meta>No files match.</Meta>}
    {r.files.map((f) => line(f.name, `${f.kind} · modified ${day(f.modifiedAt)}`, f.link ? <a href={f.link} target="_blank" rel="noreferrer">open</a> : undefined))}
  </>);
}
function DriveFileCard({ result }: ResultAppProps) {
  const r = result as { file?: { name: string; kind: string; link?: string }; text?: string | null; truncated?: boolean; note?: string; connected?: boolean } | null;
  if (!r?.connected || !r.file) return null;
  return rows(<>
    <div className="ask-app__head">{r.file.name} <Chip>{r.file.kind}</Chip> {r.file.link && <a href={r.file.link} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>open</a>}</div>
    {r.text ? <pre className="ask-app__pre">{r.text.slice(0, 3000)}{r.truncated || r.text.length > 3000 ? '\n…' : ''}</pre> : <Meta>{r.note ?? 'not read as text'}</Meta>}
  </>);
}

// ── Memory · routines ──
function MemoryFactsCard({ result }: ResultAppProps) {
  const r = result as { facts?: Array<{ id: string; fact: string; learnedAt: string; source: string }> } | null;
  if (!r?.facts) return null;
  return rows(<>
    {r.facts.length === 0 && <Meta>Nothing remembered yet.</Meta>}
    {r.facts.slice(0, 12).map((f) => line(f.fact, `${f.source === 'you' ? 'you told me' : f.source === 'agent' ? 'your agent learned' : 'from a connected account'} · ${day(f.learnedAt)}`))}
    {r.facts.length > 12 && <Meta>{r.facts.length - 12} more on Memory.</Meta>}
  </>);
}
function RoutinesCard({ result }: ResultAppProps) {
  const r = result as { routines?: Array<{ id: string; when?: string; every: string; ask: string; nextAt: string | null; paused: boolean; last?: { outcome: string; at: string | null } | null }> } | null;
  if (!r?.routines) return null;
  return rows(<>
    {r.routines.length === 0 && <Meta>No routines yet.</Meta>}
    {r.routines.map((x) => line(x.ask, `${x.when ?? x.every}${x.nextAt ? ` · next ${day(x.nextAt)} ${hm(x.nextAt)}` : ''}${x.last ? ` · last ${x.last.outcome}` : ''}`, x.paused ? <Chip>paused</Chip> : undefined))}
  </>);
}
function RoutineCard({ result }: ResultAppProps) {
  const r = result as { kept?: boolean; ask?: string; when?: string; firstAt?: string; tz?: string } | null;
  if (!r?.kept) return null;
  return rows(line(r.ask ?? '', `${r.when}${r.firstAt ? ` · first ${day(r.firstAt)} ${hm(r.firstAt)}` : ''}${r.tz ? ` (${r.tz})` : ''}`, <a href="/routines">Routines</a>));
}

// ── Money · grants (the contracts named these before this registry existed) ──
function PaymentReceiptCard({ result }: ResultAppProps) {
  const r = result as { txHash?: string; amount?: string | number; usdc?: string | number; payee?: string; payeeName?: string; from?: string; memo?: string } | null;
  if (!r?.txHash) return null;
  return rows(<KeyValue rows={[['Paid', `${r.usdc ?? r.amount ?? ''} USDC`], ['To', r.payeeName ?? r.payee ?? ''], ...(r.memo ? [['For', String(r.memo)] as [ReactNode, ReactNode]] : []), ['Transaction', <Mono key="t">{String(r.txHash).slice(0, 18)}…</Mono>]]} />);
}
function PaymentReview({ requirement, args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Pay', `${a.usdc ?? a.amount ?? '?'} USDC`], ['To', String(a.payee ?? '?')], ...(a.memo ? [['For', String(a.memo)] as [ReactNode, ReactNode]] : []), ['Under', `a mandate for ${requirement.actions.join(', ')} until ${new Date(requirement.validUntil * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`]]} />);
}
function ReviewCard({ requirement, capability, args }: ReviewAppProps) {
  const a = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object').slice(0, 6);
  return rows(<KeyValue rows={[['Act', capability], ...a.map(([k, v]) => [k, String(v)] as [ReactNode, ReactNode]), ['Under', `a mandate for ${requirement.actions.join(', ')}${requirement.locations?.length ? ` at ${requirement.locations.length} place${requirement.locations.length === 1 ? '' : 's'}` : ''}`]]} />);
}

export const RESULT_APPS: Record<string, (p: ResultAppProps) => ReactNode> = {
  CalendarEventsCard, CalendarEventCard, MailThreadsCard, MailThreadCard, MailDraftCard, MailSentCard, DriveFilesCard, DriveFileCard, MemoryFactsCard, RoutinesCard, RoutineCard, PaymentReceiptCard, WebPageCard,
};
export const REVIEW_APPS: Record<string, (p: ReviewAppProps) => ReactNode> = {
  CalendarEventReview, MailDraftReview, MailSendReview, PaymentReview,
  MemberInvitationReview: ReviewCard, ContactAddReview: ReviewCard, ContactRemoveReview: ReviewCard, PrimaryPayeeReview: ReviewCard, AccessRevokeReview: ReviewCard,
};

/** The result app for a reply, when its binding names one this Home knows. */
export function resultApp(name: string | undefined, props: ResultAppProps): ReactNode {
  const C = name ? RESULT_APPS[name] : undefined;
  return C ? C(props) : null;
}
export function reviewApp(name: string | undefined, props: ReviewAppProps): ReactNode {
  const C = name ? REVIEW_APPS[name] : undefined;
  return C ? C(props) : null;
}
