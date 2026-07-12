'use client';
// Accessible tabs — in-house. role=tablist/tab/tabpanel, roving tabindex, ←/→/Home/End keyboard nav,
// aria-selected + aria-controls wiring. Data-driven: pass the tab list; the active panel renders below.
import { useId, useRef, useState, type ReactNode } from 'react';
import './ui.css';

export interface TabItem { id: string; label: ReactNode; content: ReactNode }

export function Tabs({
  tabs,
  value,
  onValueChange,
  'aria-label': ariaLabel,
}: {
  tabs: TabItem[];
  /** Controlled active tab id; omit for uncontrolled (first tab initially). */
  value?: string;
  onValueChange?: (id: string) => void;
  'aria-label'?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(tabs[0]?.id ?? '');
  const active = value ?? uncontrolled;
  const select = (id: string) => { onValueChange?.(id); if (value === undefined) setUncontrolled(id); };
  const baseId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const id = tabs[next]!.id;
    select(id);
    refs.current[id]?.focus();
  };

  const activeTab = tabs.find((t) => t.id === active);
  return (
    <div>
      <div role="tablist" aria-label={ariaLabel} className="ap-tablist" onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => { refs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className="ap-tab"
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {activeTab && (
        <div role="tabpanel" id={`${baseId}-panel-${activeTab.id}`} aria-labelledby={`${baseId}-tab-${activeTab.id}`} tabIndex={0}>
          {activeTab.content}
        </div>
      )}
    </div>
  );
}
