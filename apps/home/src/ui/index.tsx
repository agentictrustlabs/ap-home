// THE UI SYSTEM — the primitives every portal page composes (2026-09-12). One header shape, one section shape, one
// list, one card, one key-value grid, one empty state, one "could not be read" state (398 §6.3), one toolbar, one tab
// row, one chip, one button. A page that needs something these do not give adds it HERE, named, never inline — the
// disjointedness this replaces was 2,000 inline style objects each deciding a font size for itself.
//
// Doctrine the system encodes: an EMPTY read and an UNREADABLE read are different sentences (§6.3) — `Empty` says a
// fact ("nothing is waiting on you"), `Unknown` says a failure and names the read; amber is the one primary action and
// the active mark, never a background wash; a row's title links, its controls do not ride inside the link.
import type { ReactNode, ButtonHTMLAttributes, AnchorHTMLAttributes } from 'react';

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
