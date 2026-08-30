'use client';
// One renderer per `FieldControl` (design §3.2 anatomy, §3.3 control table, §3.4 tri-state).
// Every row has the SAME skeleton: label + badge + source link, always-visible help, the control, and
// "Restore inherited" when the field carries an override.
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { CardEditorFieldV1 } from '@agenticprimitives/home';
import type { FieldBindingV1 } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { badgeFor, sourceWords, triStateOf, TRI_HELP, type TriState } from '../../lib/studio-view';
import { CodeBadge, FieldBadgeChip, inputStyle, iconButtonStyle } from './ui';

/**
 * "Restore inherited" — SERVICE GAP: `agent-profile`'s `acceptInherited` exists but no Studio op exposes it
 * (`apps/demo-a2a/src/agent-card-studio.ts` maps every patch to `applyOverride`). The affordance stays
 * visible so the model is legible, and says exactly why it can't act rather than doing something else.
 */
const RESTORE_UNAVAILABLE =
  "Restoring the inherited value needs a service operation this wave doesn't expose (agent-profile's acceptInherited isn't wired to a Studio op).";

export function FieldShell({
  field,
  binding,
  diagnostics,
  control,
  focused,
  onInspect,
}: {
  field: CardEditorFieldV1;
  binding: FieldBindingV1 | undefined;
  diagnostics: ProjectionDiagnosticV1[];
  control: ReactNode;
  focused: boolean;
  /** Opens the Inspector flyout scoped to this field — Validation if it has diagnostics, else Provenance. */
  onInspect?: (pointer: string) => void;
}) {
  const badge = badgeFor(binding, diagnostics);
  const showSource = badge === 'inherited' || badge === 'stale' || badge === 'computed';
  const [sourceOpen, setSourceOpen] = useState(false);
  return (
    <div
      id={`field-${field.pointer.replace(/\//g, '-')}`}
      style={{
        padding: '.8rem 0',
        borderBottom: '1px solid var(--c-g200)',
        ...(focused ? { background: 'var(--c-primary-subtle)', borderRadius: 8, padding: '.8rem .6rem' } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '.82rem', fontWeight: 700, color: 'var(--c-g900)' }}>
          {field.label}
          {field.required && (
            <span title="Required" style={{ marginLeft: '.15rem', color: 'var(--c-g700)' }}>
              *
            </span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <FieldBadgeChip badge={badge} />
        {showSource && (
          <button
            type="button"
            style={{ ...iconButtonStyle, minWidth: 28, minHeight: 28 }}
            aria-expanded={sourceOpen}
            title="Where this value comes from"
            onClick={() => setSourceOpen((o) => !o)}
          >
            ↗
          </button>
        )}
        {onInspect && (
          <button
            type="button"
            style={{ ...iconButtonStyle, minWidth: 28, minHeight: 28, fontSize: '.68rem' }}
            title={diagnostics.length > 0 ? 'Inspect — open Validation for this field' : 'Inspect — open Provenance for this field'}
            onClick={() => onInspect(field.pointer)}
          >
            Inspect
          </button>
        )}
      </div>
      {sourceOpen && (
        <p className="manage-card-blurb" style={{ margin: '.3rem 0', color: 'var(--c-g700)' }}>
          {sourceWords(binding?.source.kind)}
          {binding?.source.ref ? ` · ${binding.source.ref}` : ''}
        </p>
      )}
      <p className="manage-card-blurb" style={{ margin: '.15rem 0 .45rem' }}>
        {field.help}
      </p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '.5rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{control}</div>
        {binding?.mode === 'override' && (
          <button
            type="button"
            disabled
            title={RESTORE_UNAVAILABLE}
            style={{ ...iconButtonStyle, minHeight: 40, whiteSpace: 'nowrap', opacity: 0.55, cursor: 'not-allowed' }}
          >
            Restore inherited
          </button>
        )}
      </div>
      {diagnostics.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '.45rem 0 0', padding: 0, display: 'grid', gap: '.25rem' }}>
          {diagnostics.map((d, i) => (
            <li key={`${d.code}-${i}`} style={{ fontSize: '.75rem', color: d.severity === 'error' ? 'var(--c-danger)' : 'var(--color-amber-700)' }}>
              <CodeBadge code={d.code} /> {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── controls ─────────────────────────────────────────────────────────────────────────────────────

export function TextControl({
  value,
  multiline,
  url,
  readOnly,
  onCommit,
  ariaLabel,
}: {
  value: string;
  multiline?: boolean;
  url?: boolean;
  readOnly: boolean;
  onCommit(next: string): void;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const invalid = url && local.length > 0 && !/^https?:\/\//i.test(local);
  const commit = (): void => {
    if (local !== value) onCommit(local);
  };
  return (
    <div>
      {multiline ? (
        <textarea
          aria-label={ariaLabel}
          value={local}
          rows={4}
          disabled={readOnly}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }}
        />
      ) : (
        <div style={{ display: 'flex', gap: '.35rem', alignItems: 'center' }}>
          <input
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            value={local}
            disabled={readOnly}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            style={{ ...inputStyle, ...(invalid ? { borderColor: 'var(--c-danger)' } : {}) }}
          />
          {url && local.length > 0 && !invalid && (
            <a href={local} target="_blank" rel="noreferrer" style={{ ...iconButtonStyle, textDecoration: 'none' }} title="Open in a new tab">
              ↗
            </a>
          )}
        </div>
      )}
      {invalid && (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger)', margin: '.3rem 0 0' }}>
          This needs a full URL, starting with https://.
        </p>
      )}
    </div>
  );
}

/** Three-way radio GROUP — never a checkbox: `unset` and explicit `false` are different documents (§3.4). */
export function TriStateControl({
  value,
  label,
  readOnly,
  evidenceNeeded,
  onCommit,
}: {
  value: unknown;
  label: string;
  readOnly: boolean;
  evidenceNeeded: boolean;
  onCommit(next: boolean | undefined): void;
}) {
  const name = useId();
  const state = triStateOf(value);
  const options: Array<{ id: TriState; label: string }> = [
    { id: 'unset', label: 'Unset' },
    { id: 'no', label: 'No' },
    { id: 'yes', label: 'Yes' },
  ];
  return (
    <div>
      <div role="radiogroup" aria-label={label} style={{ display: 'inline-flex', border: '1px solid var(--c-g300)', borderRadius: 8, overflow: 'hidden' }}>
        {options.map((o) => (
          <label
            key={o.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '.3rem',
              padding: '.5rem .7rem',
              minHeight: 40,
              fontSize: '.8rem',
              cursor: readOnly ? 'not-allowed' : 'pointer',
              background: state === o.id ? 'var(--c-primary-subtle)' : 'var(--color-surface)',
              color: state === o.id ? 'var(--c-primary)' : 'var(--c-g700)',
              fontWeight: state === o.id ? 700 : 500,
              borderRight: o.id === 'yes' ? 'none' : '1px solid var(--c-g200)',
            }}
          >
            <input
              type="radio"
              name={name}
              checked={state === o.id}
              disabled={readOnly}
              onChange={() => onCommit(o.id === 'unset' ? undefined : o.id === 'yes')}
            />
            {o.label}
          </label>
        ))}
      </div>
      <p className="manage-card-blurb" style={{ margin: '.35rem 0 0' }}>
        {TRI_HELP[state]}
      </p>
      {state === 'yes' && evidenceNeeded && (
        <p className="manage-card-blurb" style={{ margin: '.25rem 0 0', color: 'var(--color-amber-700)' }}>
          The runtime doesn&rsquo;t confirm this yet — this will show as <b>evidence needed</b> until the running agent confirms it.
        </p>
      )}
    </div>
  );
}

const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Chip input: type + Enter adds, × removes. `mime` marks non-MIME entries inline, not at Validate time. */
export function ChipListControl({
  values,
  readOnly,
  mime,
  ariaLabel,
  placeholder,
  onCommit,
}: {
  values: string[];
  readOnly: boolean;
  mime?: boolean;
  ariaLabel: string;
  placeholder?: string;
  onCommit(next: string[]): void;
}) {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft('');
      return;
    }
    onCommit([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem', marginBottom: '.35rem' }}>
        {values.map((v) => {
          const bad = mime && !MIME_SHAPE.test(v);
          return (
            <span
              key={v}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '.25rem',
                fontSize: '.75rem',
                borderRadius: 999,
                padding: '.15rem .3rem .15rem .55rem',
                background: bad ? 'transparent' : 'var(--c-g100)',
                border: bad ? '1px solid var(--c-danger)' : '1px solid transparent',
                color: bad ? 'var(--c-danger)' : 'var(--c-g700)',
              }}
            >
              {v}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  onClick={() => onCommit(values.filter((x) => x !== v))}
                  style={{ ...iconButtonStyle, minWidth: 24, minHeight: 24, padding: '.15rem .3rem', border: 'none', background: 'transparent' }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {values.length === 0 && <span className="manage-card-blurb">Nothing yet.</span>}
      </div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: '.35rem' }}>
          <input
            aria-label={ariaLabel}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            style={inputStyle}
          />
          <button type="button" className="btn-ghost" onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

/** `securityRequirements` — multi-select over the scheme NAMES declared in Security. */
export function SecurityRequirementsControl({
  requirements,
  schemeNames,
  readOnly,
  onCommit,
}: {
  requirements: Array<Record<string, string[]>>;
  schemeNames: string[];
  readOnly: boolean;
  onCommit(next: Array<Record<string, string[]>>): void;
}) {
  if (schemeNames.length === 0) {
    return (
      <p className="manage-card-blurb">
        Declare a security scheme first — a requirement can only reference a scheme this card declares.
      </p>
    );
  }
  const selected = new Set(requirements.flatMap((r) => Object.keys(r)));
  const toggle = (name: string): void => {
    const next = selected.has(name)
      ? requirements.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== name))).filter((r) => Object.keys(r).length > 0)
      : [...requirements, { [name]: [] }];
    onCommit(next);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
      {schemeNames.map((n) => (
        <button
          key={n}
          type="button"
          disabled={readOnly}
          aria-pressed={selected.has(n)}
          onClick={() => toggle(n)}
          style={{
            ...iconButtonStyle,
            minHeight: 36,
            padding: '.35rem .6rem',
            background: selected.has(n) ? 'var(--c-primary-subtle)' : 'var(--color-surface)',
            color: selected.has(n) ? 'var(--c-primary)' : 'var(--c-g700)',
            fontWeight: selected.has(n) ? 700 : 500,
          }}
        >
          {selected.has(n) ? '✓ ' : ''}
          {n}
        </button>
      ))}
      {[...selected].filter((n) => !schemeNames.includes(n)).map((n) => (
        <span key={n} style={{ fontSize: '.75rem', color: 'var(--c-danger)', border: '1px solid var(--c-danger)', borderRadius: 999, padding: '.15rem .5rem' }}>
          {n} — not declared
          <button type="button" aria-label={`Remove ${n}`} onClick={() => toggle(n)} style={{ ...iconButtonStyle, border: 'none', background: 'transparent', minWidth: 22, minHeight: 22 }}>
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

export function ExtensionListControl({
  values,
  readOnly,
  onCommit,
}: {
  values: Array<{ uri: string; required?: boolean; description?: string }>;
  readOnly: boolean;
  onCommit(next: Array<{ uri: string; required?: boolean; description?: string }>): void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div>
      {values.length === 0 && <p className="manage-card-blurb">No extensions declared.</p>}
      {values.map((e, i) => (
        <div key={`${e.uri}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.25rem 0' }}>
          <code style={{ fontSize: '.75rem', flex: 1, wordBreak: 'break-all' }}>{e.uri}</code>
          {!readOnly && (
            <button type="button" aria-label={`Remove ${e.uri}`} onClick={() => onCommit(values.filter((_, j) => j !== i))} style={iconButtonStyle}>
              ×
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div style={{ display: 'flex', gap: '.35rem', marginTop: '.35rem' }}>
          <input aria-label="Extension URI" placeholder="https://…" value={draft} onChange={(e) => setDraft(e.target.value)} style={inputStyle} />
          <button
            type="button"
            className="btn-ghost"
            disabled={!draft.trim()}
            onClick={() => {
              onCommit([...values, { uri: draft.trim() }]);
              setDraft('');
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export function ReadonlyControl({ value }: { value: unknown }) {
  const text = value === undefined || value === null ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      style={{
        margin: 0,
        background: 'var(--c-g50)',
        border: '1px solid var(--c-g200)',
        borderRadius: 8,
        padding: '.5rem .7rem',
        fontSize: '.75rem',
        maxHeight: 180,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

/** Scroll + FOCUS a field row (design §11: the inspector's click-to-scroll moves focus, not just the viewport). */
export function useScrollToField(pointer: string | null): void {
  useEffect(() => {
    if (!pointer) return;
    const el = document.getElementById(`field-${pointer.replace(/\//g, '-')}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusable = el.querySelector<HTMLElement>('input, textarea, button, select, a[href]');
    focusable?.focus();
  }, [pointer]);
}
