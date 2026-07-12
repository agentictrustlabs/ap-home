'use client';
// Tooltip — in-house. Shows on hover AND keyboard focus, hides on blur/leave/ESC, small open delay.
// role="tooltip" + aria-describedby wiring on the wrapped child. Content must be a short string/node.
import { useId, useRef, useState, cloneElement, type ReactElement, type ReactNode } from 'react';

export function Tooltip({
  content,
  side = 'top',
  children,
  delayMs = 300,
}: {
  content: ReactNode;
  side?: 'top' | 'bottom';
  /** A single focusable element (button/link). Gets aria-describedby + hover/focus handlers. */
  children: ReactElement<Record<string, unknown>>;
  delayMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => { timer.current = setTimeout(() => setOpen(true), delayMs); };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); };

  const childProps = (children.props ?? {}) as Record<string, unknown>;
  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') hide(); (childProps.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined)?.(e); },
  });

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger}
      {open && (
        <span
          role="tooltip"
          id={id}
          className="ap-tooltip"
          style={side === 'top' ? { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' } : { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
