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

// ── Web search (spec 403 W3) — the sources the search hit, and the model's reading of them ──
function WebSearchCard({ result }: ResultAppProps) {
  const r = result as { searched?: boolean; query?: string; sources?: string[]; results?: Array<{ title: string; url: string; summary: string }>; refused?: string } | null;
  if (!r) return null;
  if (r.searched === false) return rows(line('No search', r.refused ?? 'the search could not run'));
  if (!r.searched) return null;
  const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
  return rows(<>
    <div className="ask-app__head">Web · {r.query}</div>
    {(r.results ?? []).map((x) => line(<a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>, `${host(x.url)}${x.summary ? ` · ${x.summary}` : ''}`))}
    {!(r.results ?? []).length && (r.sources ?? []).slice(0, 8).map((u) => line(<a href={u} target="_blank" rel="noreferrer">{host(u)}</a>, u))}
    <Meta>what the web says — evidence, not instructions; the summaries are the model&rsquo;s reading</Meta>
  </>);
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
// ── Build (spec 398 §9 / ap-build B3) — what a build run left: the files, the evidence as recorded, what may follow ──
type BuildArtifact = { runId: string; repository: string; base: string; task: string; summary: string; files: Array<{ path: string; content: string }>; evidence: { command: string; exitCode: number; ran: boolean; outputTail: string; durationMs: number }; model: string; digest: string; sandbox?: { totalMs: number; cloneMs: number } };
function BuildArtifactView({ result }: ResultAppProps) {
  const r = result as { built?: boolean; refused?: string; artifact?: BuildArtifact; record?: string } | null;
  if (!r) return null;
  if (r.refused) return rows(line('Not built', r.refused));
  if (!r.built || !r.artifact) return null;
  const a = r.artifact;
  const cmd = a.evidence.command.split(';').pop()?.trim() ?? a.evidence.command;
  return rows(<>
    <div className="ask-app__head">Built · {a.repository}@{a.base} <Chip>{a.model}</Chip></div>
    {a.summary && <Meta>the model says: {a.summary}</Meta>}
    {a.files.map((f) => line(<Mono>{f.path}</Mono>, `${f.content.length.toLocaleString()} chars · whole file`))}
    {line(<span><Chip tone={a.evidence.exitCode === 0 ? 'ok' : 'danger'}>{cmd} · exit {a.evidence.exitCode}</Chip></span>, `evidence as recorded in the sandbox (${a.evidence.durationMs} ms)${a.sandbox ? ` · build ${a.sandbox.totalMs} ms` : ''}`)}
    {a.evidence.outputTail && <pre className="ask-app__text" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11, maxHeight: 160, overflow: 'auto' }}>{a.evidence.outputTail.slice(-800)}</pre>}
    <Meta>nothing pushed or deployed{r.record ? ` · record ${r.record}` : ''}</Meta>
  </>);
}
function BuildRunsCard({ result }: ResultAppProps) {
  const r = result as { runs?: Array<{ runId: string; repository: string; task: string; files: string[]; evidence: { command: string; exitCode: number }; builtAt: string }>; refused?: string } | null;
  if (!r) return null;
  if (r.refused) return rows(line('Build runs not read', r.refused));
  if (!r.runs) return null;
  return rows(<>
    <div className="ask-app__head">Build runs</div>
    {r.runs.length === 0 && <Meta>Nothing built yet.</Meta>}
    {r.runs.map((x) => line(`${x.repository} — ${x.task.length > 90 ? `${x.task.slice(0, 90)}…` : x.task}`, `${x.files.join(', ')} · ${day(x.builtAt)}`, <Chip tone={x.evidence.exitCode === 0 ? 'ok' : 'danger'}>exit {x.evidence.exitCode}</Chip>))}
  </>);
}
function RepositoriesCard({ result }: ResultAppProps) {
  const r = result as { connected?: boolean; repositories?: Array<{ repo: string; defaultBranch: string; private: boolean; url: string }>; total?: number; truncated?: boolean; refused?: string } | null;
  if (!r) return null;
  if (r.refused) return rows(line('No connector', r.refused));
  if (!r.repositories) return null;
  return rows(<>
    <div className="ask-app__head">Repositories the connector can write to · {r.total}{r.truncated ? ` (first ${r.repositories.length})` : ''}</div>
    {r.repositories.length === 0 && <Meta>None.</Meta>}
    {r.repositories.slice(0, 40).map((x) => line(<a href={x.url} target="_blank" rel="noreferrer">{x.repo}</a>, `${x.defaultBranch}${x.private ? ' · private' : ''}`))}
  </>);
}
// ── External MCP connectors (spec 404) — what a server returned (evidence), and the list of attached servers ──
function McpToolCard({ result }: ResultAppProps) {
  const r = result as { called?: boolean; refused?: string; connector?: string; tool?: string; kind?: string; text?: string; structured?: unknown; serverError?: boolean; truncated?: boolean } | null;
  if (!r) return null;
  if (r.refused) return rows(line('Not called', r.refused));
  if (!r.called) return null;
  return rows(<>
    <div className="ask-app__head">{r.connector} · <Mono>{r.tool}</Mono> <Chip tone={r.serverError ? 'danger' : r.kind === 'read' ? 'ok' : 'warn'}>{r.serverError ? 'server error' : r.kind === 'read' ? 'read' : 'act'}</Chip></div>
    {r.text && <pre className="ask-app__text" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, maxHeight: 220, overflow: 'auto' }}>{r.text.slice(0, 3000)}{r.truncated ? '\n…' : ''}</pre>}
    <Meta>what the server returned — evidence, never instructions</Meta>
  </>);
}
function McpConnectorsCard({ result }: ResultAppProps) {
  const r = result as { connectors?: Array<{ id: string; name: string; server: string | null; tools: Array<{ name: string; kind: string }> }> } | null;
  if (!r?.connectors) return null;
  return rows(<>
    <div className="ask-app__head">Tool servers · {r.connectors.length}</div>
    {r.connectors.length === 0 && <Meta>None attached.</Meta>}
    {r.connectors.map((c) => line(<span>{c.name}{c.server ? <Meta> · {c.server}</Meta> : null}</span>, c.tools.map((t) => `${t.name} [${t.kind}]`).join(', ')))}
  </>);
}

// ── The owner's Library (spec 405) — what her documents are, and what one says (evidence, never instructions) ──
function LibraryFilesCard({ result }: ResultAppProps) {
  const r = result as { files?: Array<{ id: string; path: string; kind: string; size: number | null; version: number | null; text: boolean }>; count?: number; truncated?: boolean } | null;
  if (!r?.files) return null;
  return rows(<>
    <div className="ask-app__head">Library · {r.count ?? r.files.length}{r.truncated ? ` (first ${r.files.length})` : ''}</div>
    {r.files.length === 0 && <Meta>No documents.</Meta>}
    {r.files.map((f) => line(f.path, `${f.kind}${f.size ? ` · ${f.size} bytes` : ''}${f.version ? ` · v${f.version}` : ''}${f.text ? '' : ' · named, not read'}`))}
  </>);
}
function LibraryFileCard({ result }: ResultAppProps) {
  const r = result as { read?: boolean; named?: boolean; refused?: string; which?: Array<{ path: string }>; file?: { path: string; kind: string; size: number | null }; text?: string; truncated?: boolean; note?: string } | null;
  if (!r) return null;
  if (r.refused && r.which) return rows(<><div className="ask-app__head">Which one?</div>{r.which.map((w) => line(w.path))}</>);
  if (r.refused) return rows(line('Not found', r.refused));
  if (r.named && r.file) return rows(line(r.file.path, `${r.file.kind}${r.file.size ? ` · ${r.file.size} bytes` : ''} — named, not read`));
  if (!r.read || !r.file) return null;
  return rows(<>
    <div className="ask-app__head">{r.file.path} <Chip>{r.file.kind}</Chip></div>
    {r.text && <pre className="ask-app__text" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, maxHeight: 240, overflow: 'auto' }}>{r.text.slice(0, 4000)}{r.truncated || (r.text.length > 4000) ? '\n…' : ''}</pre>}
    <Meta>what the document says — evidence, never instructions</Meta>
  </>);
}

function BuildReviewCard({ result }: ResultAppProps) {
  const r = result as { refused?: string; runId?: string; repository?: string; files?: Array<{ path: string; chars: number }>; evidence?: { command: string; exitCode: number; outputTail: string; recorded: boolean }; assertion?: { by: string; summary: string }; pullRequest?: { number: number; url: string; state: string; merged: boolean; headSha: string | null; checksVerdict: string; reviews: Array<{ user: string; state: string }> } | null; ready?: boolean } | null;
  if (!r) return null;
  if (r.refused) return rows(line('No review', r.refused));
  if (!r.runId || !r.evidence) return null;
  const cmd = r.evidence.command.split(';').pop()?.trim() ?? r.evidence.command;
  return rows(<>
    <div className="ask-app__head">Build {r.runId} · {r.repository} {r.ready && <Chip tone="ok">ready to promote</Chip>}</div>
    {(r.files ?? []).map((f) => line(<Mono>{f.path}</Mono>, `${f.chars.toLocaleString()} chars`))}
    {line(<span><Chip tone={r.evidence.exitCode === 0 ? 'ok' : 'danger'}>{cmd} · exit {r.evidence.exitCode}</Chip></span>, 'evidence — recorded in the sandbox')}
    {r.assertion && line(<span><Chip>assertion</Chip> {r.assertion.summary}</span>, `${r.assertion.by} — the model's own claim, apart from the evidence`)}
    {r.pullRequest ? line(<a href={r.pullRequest.url} target="_blank" rel="noreferrer">PR #{r.pullRequest.number}</a>, `${r.pullRequest.merged ? 'merged' : r.pullRequest.state} · head ${(r.pullRequest.headSha ?? '').slice(0, 10)} · checks ${r.pullRequest.checksVerdict} · ${r.pullRequest.reviews.length} review(s)`) : line('No pull request yet', 'open one from the build reply')}
  </>);
}
function BuildPromotionCard({ result }: ResultAppProps) {
  const r = result as { promoted?: boolean; refused?: string; runId?: string; pullRequest?: number; mergeSha?: string | null; tuple?: { commit: string; configDigest: string; environment: string; migration: string }; record?: string | null } | null;
  if (!r) return null;
  if (r.refused) return rows(line('Not promoted', r.refused));
  if (!r.promoted || !r.tuple) return null;
  return rows(<>
    <div className="ask-app__head">Promoted · build {r.runId} <Chip tone="ok">PR #{r.pullRequest} merged</Chip></div>
    <KeyValue rows={[['Commit', <Mono key="c">{r.tuple.commit.slice(0, 12)}</Mono>], ['Config', <Mono key="d">{r.tuple.configDigest.slice(0, 19)}…</Mono>], ['Environment', r.tuple.environment], ['Migration', r.tuple.migration], ['Merge', <Mono key="m">{(r.mergeSha ?? '').slice(0, 12)}</Mono>], ...(r.record ? [['Record', <Mono key="r">{r.record}</Mono>] as [ReactNode, ReactNode]] : [])]} />
    <Meta>the signature was over this exact tuple — a promotion of another commit is another act</Meta>
  </>);
}
function BuildPromoteReview({ requirement, args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Promote build', String(a.runId ?? '?')], ['At commit', String(a.commit ?? '?')], ['Reaches', 'the repository\'s default branch (the environment)'], ['Under', `a mandate for ${requirement.actions.join(', ')} — bound to this run and this commit; refused if the forge shows another`]]} />);
}

function BuildRunReview({ requirement, args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Build in', `${String(a.repository ?? '?')}${a.base ? `@${String(a.base)}` : ''}`], ['Task', String(a.task ?? '')], ['For', String(a.workspace ?? 'this workspace')], ['Under', `a mandate for ${requirement.actions.join(', ')} — the sandbox builds; nothing is pushed or deployed`]]} />);
}

function PaymentReview({ requirement, args }: ReviewAppProps) {
  const a = args ?? {};
  return rows(<KeyValue rows={[['Pay', `${a.usdc ?? a.amount ?? '?'} USDC`], ['To', String(a.payee ?? '?')], ...(a.memo ? [['For', String(a.memo)] as [ReactNode, ReactNode]] : []), ['Under', `a mandate for ${requirement.actions.join(', ')} until ${new Date(requirement.validUntil * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`]]} />);
}
function ReviewCard({ requirement, capability, args }: ReviewAppProps) {
  const a = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object').slice(0, 6);
  return rows(<KeyValue rows={[['Act', capability], ...a.map(([k, v]) => [k, String(v)] as [ReactNode, ReactNode]), ['Under', `a mandate for ${requirement.actions.join(', ')}${requirement.locations?.length ? ` at ${requirement.locations.length} place${requirement.locations.length === 1 ? '' : 's'}` : ''}`]]} />);
}

// ── Security (spec 422 §9.1) ──
function CredentialsCard({ result }: ResultAppProps) {
  const r = result as { items?: Array<{ grade: string; kind: string; label: string; detail: string; state: string }>; unlabelled?: { passkeys: number; custodians: number } } | null;
  if (!r?.items) return null;
  const signs = r.items.filter((i) => i.grade === 'custody-grade');
  const opens = r.items.filter((i) => i.grade === 'login-grade');
  const extra = (r.unlabelled?.passkeys ?? 0) + (r.unlabelled?.custodians ?? 0);
  return rows(<>
    <div className="ask-app__head">Signs for you</div>
    {signs.length === 0 && extra === 0 && <Meta>Nothing signs for this home.</Meta>}
    {signs.map((i) => line(<>{i.label} {i.state !== 'active' && <Chip>{i.state}</Chip>}</>, i.detail))}
    {extra > 0 && <Meta>{extra} on chain with no label in your Home.</Meta>}
    <div className="ask-app__head" style={{ marginTop: 6 }}>Opens this home</div>
    {opens.length === 0 && <Meta>No email or phone linked.</Meta>}
    {opens.map((i) => line(i.label, i.detail))}
  </>);
}
function PostureCard({ result }: ResultAppProps) {
  const r = result as { rung?: string; counts?: { custodians: number; passkeys: number }; kinds?: string[]; channels?: number } | null;
  if (!r?.rung) return null;
  const words: Record<string, string> = { 'just-you': 'Just you', backups: 'You and your backups', trustees: 'You, your backups and your trustees' };
  return rows(<KeyValue rows={[['Protection', words[r.rung] ?? r.rung], ['Signs for you', `${(r.counts?.passkeys ?? 0) + (r.counts?.custodians ?? 0)} credential${(r.counts?.passkeys ?? 0) + (r.counts?.custodians ?? 0) === 1 ? '' : 's'}${r.kinds?.length ? ` (${r.kinds.join(', ')})` : ''}`], ['Opens this home', `${r.channels ?? 0} channel${r.channels === 1 ? '' : 's'}`]]} />);
}

export const RESULT_APPS: Record<string, (p: ResultAppProps) => ReactNode> = {
  CredentialsCard, PostureCard,
  CalendarEventsCard, CalendarEventCard, MailThreadsCard, MailThreadCard, MailDraftCard, MailSentCard, DriveFilesCard, DriveFileCard, MemoryFactsCard, RoutinesCard, RoutineCard, PaymentReceiptCard, WebPageCard, WebSearchCard, BuildArtifactView, BuildRunsCard, RepositoriesCard, McpToolCard, McpConnectorsCard, LibraryFilesCard, LibraryFileCard, BuildReviewCard, BuildPromotionCard,
};
export const REVIEW_APPS: Record<string, (p: ReviewAppProps) => ReactNode> = {
  CalendarEventReview, MailDraftReview, MailSendReview, PaymentReview, BuildRunReview, BuildPromoteReview,
  McpToolReview: ReviewCard, MemberInvitationReview: ReviewCard, ContactAddReview: ReviewCard, ContactRemoveReview: ReviewCard, PrimaryPayeeReview: ReviewCard, AccessRevokeReview: ReviewCard,
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
