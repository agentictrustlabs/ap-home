'use client';
// Anchored popover — in-house. Outside-click + ESC dismiss, focus returns to the trigger, the trigger
// gets aria-expanded/aria-haspopup. Uncontrolled by default; pass open/onOpenChange to control it.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './ui.css';

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  open: controlledOpen,
  onOpenChange,
}: {
  /** A render function receiving the props to spread onto your trigger element. */
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog'; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: ReactNode;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlledOpen ?? uncontrolled;
  const setOpen = useCallback((v: boolean) => { onOpenChange?.(v); if (controlledOpen === undefined) setUncontrolled(v); }, [controlledOpen, onOpenChange]);

  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => { if (!anchorRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, setOpen]);

  return (
    <div className="ap-popover-anchor" ref={anchorRef}>
      {trigger({
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        ref: (el) => { triggerRef.current = el; },
      })}
      {open && (
        <div ref={panelRef} id={panelId} className="ap-popover-panel" role="dialog" data-side={side} data-align={align}>
          {children}
        </div>
      )}
    </div>
  );
}
