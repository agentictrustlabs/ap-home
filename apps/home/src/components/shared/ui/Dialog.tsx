'use client';
// Accessible modal dialog — in-house (no Radix). Consolidates the hand-rolled scrim + ESC + focus
// behaviour scattered across DmSlideOver / ConsentSheet / ProfileSheet. Behaviour:
//   • role="dialog" aria-modal, labelled by the title (or an explicit aria-label)
//   • focus moves into the panel on open and is TRAPPED (Tab cycles within), restored to the opener on close
//   • ESC and scrim-click close; body scroll is locked while open
//   • one history entry is pushed so the device Back button closes it (mobile parity)
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  label,
  children,
  initialFocus,
  closeOnScrim = true,
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered as the heading + wires aria-labelledby. Omit and pass `label` for a visually-hidden name. */
  title?: ReactNode;
  description?: ReactNode;
  /** aria-label when there is no visible title. */
  label?: string;
  children: ReactNode;
  /** Ref to focus on open; defaults to the first focusable in the panel. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  closeOnScrim?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const close = useCallback(() => onClose(), [onClose]);

  // Capture the opener, lock scroll, push a history entry, focus in — all only while open.
  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    history.pushState({ apDialog: true }, '');

    const focusTarget = initialFocus?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
    focusTarget?.focus();

    const onPop = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      // Focus trap: cycle within the panel.
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) { e.preventDefault(); return; }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus?.();
      // Drop the pushed entry if we closed for a reason other than Back.
      if (history.state?.apDialog) history.back();
    };
  }, [open, onClose, initialFocus]);

  if (!open) return null;
  return (
    <div className="ap-dialog-scrim" onMouseDown={(e) => { if (closeOnScrim && e.target === e.currentTarget) close(); }}>
      <div
        ref={panelRef}
        className="ap-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : label}
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        {title && <h2 id={titleId} className="ap-dialog-title">{title}</h2>}
        {description && <p id={descId} className="ap-dialog-desc">{description}</p>}
        {children}
      </div>
    </div>
  );
}
