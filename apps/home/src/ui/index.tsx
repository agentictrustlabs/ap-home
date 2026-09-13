// THE UI SYSTEM — the primitives every portal page composes (2026-09-12). One header shape, one section shape, one
// list, one card, one key-value grid, one empty state, one "could not be read" state (398 §6.3), one toolbar, one tab
// row, one chip, one button. A page that needs something these do not give adds it HERE, named, never inline — the
// disjointedness this replaces was 2,000 inline style objects each deciding a font size for itself.
//
// Doctrine the system encodes: an EMPTY read and an UNREADABLE read are different sentences (§6.3) — `Empty` says a
// fact ("nothing is waiting on you"), `Unknown` says a failure and names the read; amber is the one primary action and
// the active mark, never a background wash; a row's title links, its controls do not ride inside the link.
import { useId, type ReactNode, type ButtonHTMLAttributes, type AnchorHTMLAttributes, type InputHTMLAttributes } from 'react';
import { useReadyReport, usePageReady } from './ready';
export { ReadyProvider, useReadyReport, usePageReady } from './ready';

const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(' ');

/** Page header: the title, one line saying what the page answers, the page's own actions on the right. */
export function PageHead({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ui-page-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {description && <p className="ui-page-desc">{description}</p>}
        {children}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  );
}

/** A section: an uppercase label, an optional count, an optional aside (a link, a total). */
export function Section({ title, count, aside, children, testId }: { title: ReactNode; count?: number; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="ui-section" {...(testId ? { 'data-testid': testId } : {})}>
      <div className="ui-section-head">
        <h2>{title}{typeof count === 'number' && <span className="ui-count">{count}</span>}</h2>
        {aside && <div className="ui-section-aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function List({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="ui-list" {...(testId ? { 'data-testid': testId } : {})}>{children}</div>;
}

/** One row: a title (linked when `href` is given and the row carries no control of its own), a meta line, a side. */
export function Row({ title, meta, side, href, titleHref, children, testId, dataState }: {
  title: ReactNode; meta?: ReactNode; side?: ReactNode;
  /** The whole row is the link. Use only when nothing interactive sits inside the row. */
  href?: string;
  /** Only the title links — for a row that also carries a control. */
  titleHref?: string;
  children?: ReactNode; testId?: string; dataState?: string;
}) {
  const main = (
    <div className="ui-row-main">
      <div className="ui-row-title">{titleHref && !href ? <a href={titleHref}>{title}</a> : title}</div>
      {meta && <div className="ui-row-meta">{meta}</div>}
      {children}
    </div>
  );
  const attrs = { ...(testId ? { 'data-testid': testId } : {}), ...(dataState ? { 'data-state': dataState } : {}) };
  if (href) return <a className="ui-row" href={href} {...attrs}>{main}{side && <div className="ui-row-side">{side}</div>}</a>;
  return <div className="ui-row" {...attrs}>{main}{side && <div className="ui-row-side">{side}</div>}</div>;
}

export function Card({ title, head, children, quiet, href, testId, className, style }: { title?: ReactNode; head?: ReactNode; children: ReactNode; quiet?: boolean; href?: string; testId?: string; className?: string; style?: React.CSSProperties }) {
  const inner = (
    <>
      {(title || head) && <div className="ui-card-head">{title && <div className="ui-card-title">{title}</div>}{head}</div>}
      {children}
    </>
  );
  const cls = cx('ui-card', quiet && 'ui-card--quiet', className);
  const attrs = { className: cls, ...(testId ? { 'data-testid': testId } : {}), ...(style ? { style } : {}) };
  return href ? <a href={href} {...attrs}>{inner}</a> : <div {...attrs}>{inner}</div>;
}

/** Label · value pairs. A value that is ABSENT is rendered faint and says so — never left blank, never invented. */
export function KeyValue({ rows }: { rows: Array<[ReactNode, ReactNode, { absent?: boolean }?]> }) {
  return (
    <dl className="ui-kv">
      {rows.map(([k, v, o], i) => (
        <FragmentRow key={i} k={k} v={v} absent={!!o?.absent} />
      ))}
    </dl>
  );
}
function FragmentRow({ k, v, absent }: { k: ReactNode; v: ReactNode; absent: boolean }) {
  return (<><dt>{k}</dt><dd className={absent ? 'ui-absent' : undefined}>{v}</dd></>);
}

/** Nothing there — a fact. One sentence, optionally one action. */
export function Empty({ title, children, action, testId }: { title?: ReactNode; children?: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="ui-empty" {...(testId ? { 'data-testid': testId } : {})}>
      {title && <div className="ui-empty-title">{title}</div>}
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

/** Could not be read — 398 §6.3. Names the read; says whether what is shown is partial. */
export function Unknown({ read, partial, testId }: { read: ReactNode; partial?: boolean; testId?: string }) {
  return (
    <div className="ui-unknown" role="status" {...(testId ? { 'data-testid': testId } : {})}>
      <span aria-hidden>⚠</span>
      <span>unknown — {read}. {partial ? 'What is shown is partial.' : 'Nothing is shown because it could not be read, not because nothing is there.'}</span>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="ui-error" role="alert">{children}</div>;
}

export function Toolbar({ children }: { children: ReactNode }) { return <div className="ui-toolbar">{children}</div>; }

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: Array<{ id: T; label: ReactNode; count?: number; disabled?: boolean }>; label?: string }) {
  return (
    <div className="ui-tabs" role="tablist" {...(label ? { 'aria-label': label } : {})}>
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" className="ui-tab" aria-selected={value === it.id} disabled={it.disabled} onClick={() => onChange(it.id)} data-testid={`tab-${it.id}`}>
          {it.label}{typeof it.count === 'number' && <span className="ui-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chip({ tone, children, title }: { tone?: 'ok' | 'warn' | 'danger'; children: ReactNode; title?: string }) {
  return <span className={cx('ui-chip', tone && `ui-chip--${tone}`)} {...(title ? { title } : {})}>{children}</span>;
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' }) {
  return <button type="button" {...rest} className={cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className)} />;
}
export function LinkButton({ variant = 'secondary', size, className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: BtnVariant; size?: 'sm' }) {
  return <a {...rest} className={cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className)} />;
}

export const Meta = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cx('ui-meta', className)}>{children}</span>;
export const Micro = ({ children }: { children: ReactNode }) => <span className="ui-micro">{children}</span>;
export const Mono = ({ children, title }: { children: ReactNode; title?: string }) => <code className="ui-mono" {...(title ? { title } : {})}>{children}</code>;
export const Note = ({ children }: { children: ReactNode }) => <p className="ui-note">{children}</p>;

/** An on/off control. `checked === null` is "not yet known" — disabled, never shown as off. */
export function Switch({ checked, onChange, busy, label, ...rest }: { checked: boolean | null; onChange: () => void; busy?: boolean; label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>) {
  return (
    <button type="button" role="switch" aria-checked={checked === true} aria-label={label} className="ui-switch" disabled={checked === null || busy} onClick={onChange} {...rest} />
  );
}


// ── DESIGN SYSTEM v2 (2026-09-13): readiness, status, panels, avatars, stats, search, day headers, a drawer ──

/** The shape of what is coming. Never an empty state. */
export function Skeleton({ width = '100%', height = 12, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <span className="ui-skel" style={{ width, height, ...style }} aria-hidden />;
}
export function SkeletonRows({ rows = 3, lead }: { rows?: number; lead?: boolean }) {
  return (
    <div className="ui-skel-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="ui-skel-row" key={i}>
          {lead && <Skeleton width={36} height={36} style={{ borderRadius: '50%' }} />}
          <div><Skeleton width={`${52 + ((i * 17) % 30)}%`} height={12} /><Skeleton width={`${28 + ((i * 11) % 22)}%`} height={10} /></div>
          <Skeleton width={72} height={20} style={{ borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

export type PanelState = 'loading' | 'ready' | 'empty' | 'unknown';

/**
 * A titled surface with ONE state. `loading` shows a skeleton (and counts toward the page's readiness); `ready`
 * shows the children; `empty` shows the fact (only ever after the read answered); `unknown` names the failed read.
 * A panel never shows an empty state while its read is still out — that is the half-done screen this replaces.
 */
export function Panel({ title, icon, count, aside, state, rows = 3, lead, empty, unknown, children, testId, id }: {
  title: ReactNode; icon?: ReactNode; count?: number; aside?: ReactNode; state: PanelState; rows?: number; lead?: boolean;
  /** The fact to say when there is nothing — a title and a line, optionally an action. */
  empty?: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode };
  /** What could not be read (398 §6.3). */
  unknown?: { read: ReactNode; partial?: boolean };
  children?: ReactNode; testId?: string; id?: string;
}) {
  const autoId = useId();
  useReadyReport(id ?? autoId, state === 'loading');
  return (
    <section className="ui-panel" {...(testId ? { 'data-testid': testId } : {})} data-state={state}>
      <div className="ui-panel-head">
        <h2>{icon}{title}{typeof count === 'number' && state === 'ready' && <span className="ui-count">{count}</span>}</h2>
        {aside && <div className="ui-panel-aside">{aside}</div>}
      </div>
      {state === 'loading' && <SkeletonRows rows={rows} {...(lead ? { lead } : {})} />}
      {state === 'unknown' && unknown && <Unknown read={unknown.read} {...(unknown.partial ? { partial: true } : {})} />}
      {(state === 'ready' || (state === 'unknown' && unknown?.partial)) && children}
      {state === 'empty' && (empty ? <EmptyState {...empty} /> : <Empty>Nothing here.</Empty>)}
    </section>
  );
}

/** An empty state with an icon — a fact, calm, one line, at most one action. */
export function EmptyState({ icon, title, hint, action, testId }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="ui-empty" {...(testId ? { 'data-testid': testId } : {})}>
      {icon && <div className="ui-empty-icon">{icon}</div>}
      <div className="ui-empty-title">{title}</div>
      {hint && <div>{hint}</div>}
      {action}
    </div>
  );
}

export type StatusTone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral' | 'accent';
/** ONE status vocabulary for every surface: the run/work state words → a tone. */
export function statusTone(state: string | undefined | null): StatusTone {
  const s = String(state ?? '').toLowerCase();
  if (/complet|done|finished|satisfied|merged|landed|ok|success|answered|active|member/.test(s)) return 'ok';
  if (/running|working|in progress|executing|open/.test(s)) return 'info';
  if (/wait|pending|parked|queued|needs|awaiting|proposed|invited|suspend/.test(s)) return 'warn';
  if (/fail|refus|denied|error|revoked|cancel|expired|blocked/.test(s)) return 'danger';
  return 'neutral';
}
export function StatusBadge({ state, label, tone, live, title }: { state?: string | null; label?: ReactNode; tone?: StatusTone; live?: boolean; title?: string }) {
  const t = tone ?? statusTone(state);
  const words = label ?? String(state ?? '').replace(/[_-]+/g, ' ').replace(/^TASK STATE /i, '').toLowerCase();
  return <span className={cx('ui-status', `ui-status--${t}`, (live ?? /running|working/.test(String(state ?? '').toLowerCase())) && 'ui-status--live')} {...(title ? { title } : {})}>{words}</span>;
}

const AVATAR_HUES = ['#5b6b8c', '#7a5c8a', '#3f7f6a', '#8a6b3f', '#4f7ca3', '#8c5b5b', '#5f8a4f', '#6b5f8c', '#3f8a8a', '#8a6f4f'];
/** Initials on a deterministic muted hue. An agent (a name with a typed suffix, or `agent`) is a rounded square. */
export function Avatar({ name, address, size, agent, src }: { name?: string | null; address?: string | null; size?: 'sm' | 'lg'; agent?: boolean; src?: string | null }) {
  const key = (name || address || '?').toLowerCase();
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const label = name || (address ? address.slice(2, 6) : '?');
  const parts = label.replace(/\.(me|org|team|svc|workspace|treasury|household|church|circle|impact|agent)$/i, '').split(/[\s._-]+/).filter(Boolean);
  const initials = (parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : label.slice(0, 2)).toUpperCase();
  const isAgent = agent ?? /\.(org|team|svc|workspace|treasury|household|church|circle|impact)$/i.test(label);
  return (
    <span className={cx('ui-avatar', size && `ui-avatar--${size}`, isAgent && 'ui-avatar--agent')} style={{ ['--av' as string]: AVATAR_HUES[h % AVATAR_HUES.length], ...(src ? { backgroundImage: `url(${src})`, backgroundSize: 'cover', color: 'transparent' } : {}) }} aria-hidden>
      {src ? '' : initials}
    </span>
  );
}

/** The numbers a page opens with. */
export function Stats({ children }: { children: ReactNode }) { return <div className="ui-stats">{children}</div>; }
export function Stat({ label, value, hint, tone, href, loading, testId }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger'; href?: string; loading?: boolean; testId?: string }) {
  const inner = (
    <>
      <span className="ui-stat-label">{label}</span>
      {loading ? <Skeleton width={48} height={22} style={{ margin: '2px 0' }} /> : <span className="ui-stat-value" {...(tone ? { 'data-tone': tone } : {})}>{value}</span>}
      {hint && <span className="ui-stat-hint">{hint}</span>}
    </>
  );
  const attrs = { className: 'ui-stat', ...(testId ? { 'data-testid': testId } : {}) };
  return href ? <a href={href} {...attrs}>{inner}</a> : <div {...attrs}>{inner}</div>;
}

export function IconButton({ label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className="ui-iconbtn" aria-label={label} title={label} {...rest}>{children}</button>;
}

export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="ui-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" {...props} />
    </div>
  );
}

/** A control chip for filtering (unlike `Chip`, which is a fact). */
export function FilterChip({ active, count, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; count?: number }) {
  return <button type="button" className="ui-filter" aria-pressed={active} {...rest}>{children}{typeof count === 'number' && <span className="ui-count">{count}</span>}</button>;
}

/** "Today" · "Yesterday" · a date — the header a grouped list opens each day with. */
export function DayHeader({ at }: { at: number | string }) { return <div className="ui-day">{dayLabel(at)}</div>; }
export function dayLabel(at: number | string, now = Date.now()): string {
  const d = new Date(at); const t = new Date(now);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, t)) return 'Today';
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}
export function timeLabel(at: number | string): string { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
/** "just now" · "4m" · "2h" · "3d" · a date — for a row's right edge. */
export function relativeLabel(at: number | string, now = Date.now()): string {
  const ms = now - new Date(at).getTime();
  if (ms < 45_000) return 'just now';
  const m = Math.round(ms / 60_000); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A side drawer for a detail (a run's inspector, a message's provenance) — the list stays where it was. */
export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <div className="ui-drawer-backdrop" onClick={onClose} aria-hidden />
      <aside className="ui-drawer" role="dialog" aria-modal="true">
        <div className="ui-drawer-head">
          <h2>{title}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{actions}<IconButton label="Close" onClick={onClose}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg></IconButton></div>
        </div>
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </>
  );
}

/** The page's own readiness line: pulses while reads are out; says "updated" once they are all in. */
export function PageReadyLine() {
  const { busy, settledAt } = usePageReady();
  if (!busy && !settledAt) return null;
  return <div className="ui-page-ready" data-busy={busy}>{busy ? 'Reading…' : `Up to date · ${timeLabel(settledAt!)}`}</div>;
}
export function PageProgress() { const { busy } = usePageReady(); return busy ? <div className="ui-progress" role="progressbar" aria-label="Loading" /> : null; }
