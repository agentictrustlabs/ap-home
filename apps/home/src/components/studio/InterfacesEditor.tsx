'use client';
// `/supportedInterfaces` — ORDERED, first = preferred (design §3.5). Position IS the semantic, so there is
// no separate "set as preferred" control. Reorder is keyboard-operable (Alt+↑ / Alt+↓ and always-visible
// Move up / Move down buttons) — drag is never the only way to reach "first = preferred" (design §11).
import { useState } from 'react';
import type { A2AAgentInterfaceV1 } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { Chip, iconButtonStyle, inputStyle } from './ui';

const BINDINGS = ['JSONRPC', 'GRPC', 'HTTP+JSON'] as const;

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}

export function InterfacesEditor({
  interfaces,
  diagnostics,
  readOnly,
  onCommit,
}: {
  interfaces: A2AAgentInterfaceV1[];
  diagnostics: ProjectionDiagnosticV1[];
  readOnly: boolean;
  onCommit(next: A2AAgentInterfaceV1[]): void;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [binding, setBinding] = useState<string>('JSONRPC');
  const [tenant, setTenant] = useState('');

  // The validator reports divergence at the FIELD (`/supportedInterfaces`), naming the offending row in its
  // message. "extra" rows (served by nothing) and "missing" catalog rows arrive as the same code.
  const divergences = diagnostics.filter((d) => d.code === 'CATALOG_DIVERGENCE');
  const missing = divergences.filter((d) => /is missing from the card/.test(d.message));
  const extra = divergences.filter((d) => !/is missing from the card/.test(d.message));
  const rowDiverges = (i: A2AAgentInterfaceV1): boolean => extra.some((d) => d.message.includes(i.url));

  return (
    <div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '.35rem' }}>
        {interfaces.map((it, i) => (
          <li
            key={`${it.protocolBinding}-${it.url}-${i}`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (readOnly || !e.altKey) return;
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                onCommit(move(interfaces, i, i - 1));
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                onCommit(move(interfaces, i, i + 1));
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '.5rem',
              padding: '.5rem .6rem',
              border: '1px solid var(--c-g200)',
              borderLeft: rowDiverges(it) ? '3px solid var(--c-danger)' : '1px solid var(--c-g200)',
              borderRadius: 8,
              background: 'var(--color-surface)',
            }}
          >
            <span aria-hidden style={{ color: 'var(--c-g400)', cursor: 'grab' }}>
              ⠿
            </span>
            <span style={{ fontSize: '.75rem', color: 'var(--c-g500)', minWidth: '1rem' }}>{i + 1}</span>
            <span style={{ fontSize: '.78rem', fontWeight: 700 }}>{it.protocolBinding}</span>
            <code style={{ fontSize: '.75rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{it.url}</code>
            {it.tenant && <Chip tone="muted">tenant {it.tenant}</Chip>}
            {i === 0 && <Chip tone="accent">Preferred</Chip>}
            {!readOnly && (
              <>
                <button
                  type="button"
                  style={iconButtonStyle}
                  title="Move up"
                  aria-label={`Move ${it.protocolBinding} ${it.url} up`}
                  disabled={i === 0}
                  onClick={() => onCommit(move(interfaces, i, i - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  style={iconButtonStyle}
                  title="Move down"
                  aria-label={`Move ${it.protocolBinding} ${it.url} down`}
                  disabled={i === interfaces.length - 1}
                  onClick={() => onCommit(move(interfaces, i, i + 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  style={iconButtonStyle}
                  title="Remove"
                  aria-label={`Remove ${it.protocolBinding} ${it.url}`}
                  onClick={() => onCommit(interfaces.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </>
            )}
          </li>
        ))}
      </ol>

      {interfaces.some(rowDiverges) && (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger)', margin: '.45rem 0 0' }}>
          Not served by this deployment — add an override to keep it, or remove it.
        </p>
      )}
      {missing.map((d, i) => (
        // Ghost row: the deployment serves something this card hasn't caught up to. The validator names it
        // in prose only, so this is a prompt to add it by hand — never a one-click Add of a parsed string.
        <p
          key={`missing-${i}`}
          className="manage-card-blurb"
          style={{ margin: '.35rem 0 0', border: '1px dashed var(--c-g300)', borderRadius: 8, padding: '.4rem .6rem' }}
        >
          {d.message}
        </p>
      ))}

      {!readOnly &&
        (adding ? (
          <div style={{ display: 'grid', gap: '.35rem', marginTop: '.5rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem' }}>
            <input aria-label="Interface URL" placeholder="https://…/api/a2a" value={url} onChange={(e) => setUrl(e.target.value)} style={inputStyle} />
            <select aria-label="Protocol binding" value={binding} onChange={(e) => setBinding(e.target.value)} style={inputStyle}>
              {BINDINGS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <input aria-label="Tenant (optional)" placeholder="tenant (optional)" value={tenant} onChange={(e) => setTenant(e.target.value)} style={inputStyle} />
            <div style={{ display: 'flex', gap: '.4rem' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!url.trim()}
                onClick={() => {
                  onCommit([...interfaces, { url: url.trim(), protocolBinding: binding, ...(tenant.trim() ? { tenant: tenant.trim() } : {}) }]);
                  setUrl('');
                  setTenant('');
                  setAdding(false);
                }}
              >
                Add interface
              </button>
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={() => setAdding(true)}>
            + Add
          </button>
        ))}
    </div>
  );
}
