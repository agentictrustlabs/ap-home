'use client';
// Registered names — every name in the naming service, most-recently-registered first. Read from the
// discovery knowledge base through the discovery MCP (ADR-0012: the home never scans the chain; the
// indexer projects AgentNameRegistry storage — name, registeredAt, expiry, agent kind — into the KB).
// Reached from the top-right identity dropdown; needs no session (the KB is world-readable, ADR-0040).
import { useCallback, useEffect, useState } from 'react';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { listRegisteredNames, type RegisteredName } from '../../../src/lib/name-directory';
import { cardSty, btnSty, mono, mutedText, errorText, inputSty, badgeStyle, shortAddr, type BadgeKind } from '../../../src/components/portal/theme';

const KIND_LABEL: Record<string, { label: string; badge: BadgeKind }> = {
  PersonAgent: { label: 'Person', badge: 'ok' },
  OrganizationAgent: { label: 'Organization', badge: 'warn' },
  ServiceAgent: { label: 'Service', badge: 'neutral' },
};

function fmtRegistered(unixSeconds: number | null): string {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  const abs = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (days < 1) return `today · ${abs}`;
  if (days < 30) return `${Math.floor(days)}d ago · ${abs}`;
  return abs;
}

export default function NamesPage() {
  const [names, setNames] = useState<RegisteredName[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setNames(null); setErr(null);
    try { setNames(await listRegisteredNames()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = (names ?? []).filter((n) => {
    const t = q.trim().toLowerCase();
    return !t || n.name.toLowerCase().includes(t) || n.smartAgent.toLowerCase().includes(t) || (n.displayName ?? '').toLowerCase().includes(t);
  });

  return (
    <SectionShell
      title="Registered names"
      actions={<button type="button" style={btnSty} onClick={() => void load()}>Refresh</button>}
    >
      <p style={{ ...mutedText, margin: '0 0 0.9rem', fontSize: '0.85rem' }}>
        Every name in the naming service, newest first — read from the public discovery knowledge base.
      </p>
      <input
        style={{ ...inputSty, marginBottom: '0.9rem', maxWidth: '28rem' }}
        placeholder="Filter by name, address, or display name…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {err && <p style={errorText}>{err}</p>}
      {!err && names === null && <p style={mutedText}>Loading…</p>}
      {names !== null && !filtered.length && <p style={mutedText}>{q ? 'No names match the filter.' : 'No names indexed yet.'}</p>}
      {filtered.length > 0 && (
        <div style={{ ...cardSty, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ ...mutedText, textAlign: 'left' }}>
                <th style={{ padding: '0.6rem 0.9rem', fontWeight: 600 }}>Name</th>
                <th style={{ padding: '0.6rem 0.9rem', fontWeight: 600 }}>Kind</th>
                <th style={{ padding: '0.6rem 0.9rem', fontWeight: 600 }}>Smart Agent</th>
                <th style={{ padding: '0.6rem 0.9rem', fontWeight: 600 }}>Registered</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => {
                const kind = n.kind ? KIND_LABEL[n.kind] : undefined;
                return (
                  <tr key={n.name} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.55rem 0.9rem' }}>
                      <span style={{ fontWeight: 600 }}>{n.name}</span>
                      {n.displayName && <span style={{ ...mutedText, marginLeft: '0.5rem' }}>{n.displayName}</span>}
                    </td>
                    <td style={{ padding: '0.55rem 0.9rem' }}>
                      {kind ? <span style={badgeStyle(kind.badge)}>{kind.label}</span> : <span style={mutedText}>—</span>}
                    </td>
                    <td style={{ padding: '0.55rem 0.9rem', ...mono }} title={n.smartAgent}>{shortAddr(n.smartAgent)}</td>
                    <td style={{ padding: '0.55rem 0.9rem', whiteSpace: 'nowrap' }}>{fmtRegistered(n.registeredAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}
