'use client';

import type { ReactNode } from 'react';

export interface SettingsTab {
  id: string;
  label: string;
  group?: string;
}

export function SettingsLayout({
  tabs,
  active,
  onSelect,
  header,
  title,
  description,
  children,
}: {
  tabs: SettingsTab[];
  active: string;
  onSelect: (id: string) => void;
  header: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const groups = tabs.reduce<string[]>((acc, t) => {
    const g = t.group ?? '';
    if (!acc.includes(g)) acc.push(g);
    return acc;
  }, []);

  return (
    <div className="settings-hub">
      <div className="settings-hub__header">{header}</div>
      <div className="settings-hub__body">
        <nav className="settings-nav" aria-label="Profile settings">
          {groups.map((group) => (
            <div key={group || 'default'}>
              {group && <div className="settings-nav__group-label">{group}</div>}
              {tabs.filter((t) => (t.group ?? '') === group).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`settings-nav__item${t.id === active ? ' settings-nav__item--active' : ''}`}
                  onClick={() => onSelect(t.id)}
                  aria-current={t.id === active ? 'page' : undefined}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-panel">
          <h2 className="settings-panel__title">{title}</h2>
          {description && <p className="settings-panel__desc">{description}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

export function SettingsGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      {label && <div className="settings-group__label">{label}</div>}
      {children}
    </div>
  );
}

export function SettingsRow({
  icon,
  label,
  value,
  href,
  onClick,
  chevron = true,
}: {
  icon?: string;
  label: string;
  value?: string;
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
}) {
  const inner = (
    <>
      {icon && <span className="settings-row__icon" aria-hidden>{icon}</span>}
      <div className="settings-row__body">
        <div className="settings-row__label">{label}</div>
        {value && <div className="settings-row__value">{value}</div>}
      </div>
      {chevron && (href || onClick) && <span className="settings-row__chevron" aria-hidden>›</span>}
    </>
  );

  if (href) {
    return <a className="settings-row" href={href}>{inner}</a>;
  }
  if (onClick) {
    return (
      <button type="button" className="settings-row" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="settings-row settings-row--static">{inner}</div>;
}
