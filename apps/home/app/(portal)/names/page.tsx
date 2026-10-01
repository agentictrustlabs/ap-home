'use client';
// Registered names — every name in the naming service, most-recently-registered first. Read from the
// discovery knowledge base through the discovery MCP (ADR-0012: the home never scans the chain; the
// indexer projects AgentNameRegistry storage — name, registeredAt, expiry, agent kind — into the KB).
// Reached from the top-right identity dropdown; needs no session (the KB is world-readable, ADR-0040).
import { useCallback, useEffect, useState } from 'react';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { getRegisteredNameMetadata, listRegisteredNames, type RegisteredName } from '../../../src/lib/name-directory';
import { cardSty, btnSty, mono, mutedText, errorText, inputSty, badgeStyle, shortAddr, modalOverlaySty, type BadgeKind } from '../../../src/components/portal/theme';

import { Loading } from '../../../src/components/shared/Loading';
const KIND_LABEL: Record<string, { label: string; badge: BadgeKind }> = {
  PersonAgent: { label: 'Person', badge: 'ok' },
  OrganizationAgent: { label: 'Organization', badge: 'warn' },
  ServiceAgent: { label: 'Service', badge: 'neutral' },
};

function kindLabel(n: RegisteredName): { label: string; badge: BadgeKind } | null {
  if (n.appContext === 'uupg' && n.orgRole === 'alliance') return { label: 'UUPG alliance', badge: 'warn' };
  if (n.appContext === 'uupg' && n.orgRole === 'organization') return { label: 'UUPG org', badge: 'warn' };
  return n.kind ? KIND_LABEL[n.kind] ?? null : null;
}

function compactIri(iri: string): string {
  return iri
    .replace('https://agenticprimitives.dev/ns/core#', 'ap:')
    .replace('https://agenticprimitives.dev/ns/naming#', 'apnam:')
    .replace('https://agenticprimitives.dev/ns/profile#', 'approf:')
    .replace('https://agenticprimitives.dev/ns/discovery#', 'apdisc:')
    .replace('https://agenticprimitives.dev/ns/registry#', 'apreg:')
    .replace('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:');
}

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
  const [open, setOpen] = useState<RegisteredName | null>(null);

  const load = useCallback(async () => {
    setNames(null); setErr(null);
    try { setNames(await listRegisteredNames()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = (names ?? []).filter((n) => {
    const t = q.trim().toLowerCase();
    return !t
      || n.name.toLowerCase().includes(t)
      || n.smartAgent.toLowerCase().includes(t)
      || (n.displayName ?? '').toLowerCase().includes(t)
      || (n.appContext ?? '').toLowerCase().includes(t)
      || (n.orgRole ?? '').toLowerCase().includes(t);
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
      {!err && names === null && <Loading />}
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
                const kind = kindLabel(n);
                return (
                  <tr key={n.name} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.55rem 0.9rem' }}>
                      <button type="button" onClick={() => setOpen(n)} style={{ border: 0, background: 'transparent', padding: 0, color: 'var(--color-link)', fontWeight: 700, cursor: 'pointer' }}>{n.name}</button>
                      {n.displayName && <span style={{ ...mutedText, marginLeft: '0.5rem' }}>{n.displayName}</span>}
                      {n.description && <div style={{ ...mutedText, marginTop: '0.18rem', maxWidth: '24rem' }}>{n.description}</div>}
                    </td>
                    <td style={{ padding: '0.55rem 0.9rem' }}>
                      {kind ? <span style={badgeStyle(kind.badge)}>{kind.label}</span> : <span style={mutedText}>—</span>}
                      {n.appContext && <div style={{ ...mutedText, marginTop: '0.2rem' }}>{n.appContext}{n.orgRole ? ` · ${n.orgRole}` : ''}</div>}
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
      {open && <MetadataDialog name={open} onClose={() => setOpen(null)} />}
    </SectionShell>
  );
}

function MetadataDialog({ name, onClose }: { name: RegisteredName; onClose: () => void }) {
  const [meta, setMeta] = useState<{ agent: string; triples: { p: string; o: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    setMeta(null); setErr(null);
    void getRegisteredNameMetadata(name.name)
      .then((m) => { if (!cancel) setMeta(m); })
      .catch((e) => { if (!cancel) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancel = true; };
  }, [name.name]);
  return (
    <div role="dialog" aria-modal="true" style={modalOverlaySty} onClick={onClose}>
      <div style={{ ...cardSty, width: 'min(760px, 96vw)', maxHeight: '86vh', overflow: 'auto', padding: '1.2rem' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'start' }}>
          <div>
            <h3 style={{ margin: 0 }}>{name.name}</h3>
            <div style={{ ...mono, ...mutedText, marginTop: '.25rem' }}>{name.smartAgent}</div>
          </div>
          <button type="button" style={btnSty} onClick={onClose}>Close</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.55rem', margin: '1rem 0' }}>
          <Info label="Kind" value={kindLabel(name)?.label ?? name.kind ?? '—'} />
          <Info label="App context" value={name.appContext ?? '—'} />
          <Info label="Org role" value={name.orgRole ?? '—'} />
          <Info label="Service URL" value={name.serviceUrl ?? '—'} />
          <Info label="Site URL" value={name.siteUrl ?? '—'} />
        </div>
        {err && <p style={errorText}>{err}</p>}
        {!err && !meta && <Loading compact label="Loading public metadata…" />}
        {meta && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' }}>
            <tbody>
              {meta.triples.map((t, i) => (
                <tr key={`${t.p}:${i}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '.45rem .6rem', ...mono, width: '15rem', verticalAlign: 'top' }}>{compactIri(t.p)}</td>
                  <td style={{ padding: '.45rem .6rem', wordBreak: 'break-word' }}>{compactIri(t.o)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: '.55rem .65rem' }}>
      <div style={{ ...mutedText, fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ marginTop: '.2rem', wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}
