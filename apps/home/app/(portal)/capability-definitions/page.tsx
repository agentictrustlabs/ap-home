'use client';
// The capability-definition explorer — the catalog an agent picks FROM (ADR-0051).
//
// Not per-agent: a definition means the same thing for everyone, which is the entire reason it exists.
// So this is a browsing surface, and the workspace-scoped decision ("do I claim this?") happens on the
// agent's own Capabilities page.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { listCapabilityDefinitions, capabilityDomains, mappingsFor } from '@agenticprimitives/capability-claims';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { cardSty, mutedText, inputSty } from '../../../src/components/portal/theme';

export default function CapabilityDefinitionsPage() {
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState('');
  const rows = useMemo(() => listCapabilityDefinitions({ query: query || undefined, domain: domain || undefined }), [query, domain]);

  return (
    <SectionShell
      title="Capability definitions"
      description="What an agent can say it does. Every agent claiming one of these claims the SAME id, which is what lets anyone match on it."
    >
      <div style={{ ...cardSty }}>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.8rem' }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search definitions"
            aria-label="search capability definitions" style={{ ...inputSty, flex: 1, minWidth: 220 }} />
          <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="filter by domain" style={{ ...inputSty, minWidth: 180 }}>
            <option value="">All domains</option>
            {capabilityDomains().map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-faint)', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                <th style={{ padding: '.4rem .5rem' }}>Capability</th>
                <th style={{ padding: '.4rem .5rem' }}>Domain</th>
                <th style={{ padding: '.4rem .5rem' }}>OASF</th>
                <th style={{ padding: '.4rem .5rem' }}>HCS-26</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const m = mappingsFor(d.id);
                const cell = (taxonomy: string) => {
                  const hit = m.find((x) => x.taxonomy === taxonomy);
                  // An empty cell is an ANSWER — "nothing published maps here at this version" — and is
                  // shown as such rather than left blank, because blank reads as "not looked at".
                  return hit
                    ? <><code style={{ fontSize: '.74rem' }}>{hit.targetClassId}</code> <span style={mutedText}>({hit.relation})</span></>
                    : <span style={{ ...mutedText, fontSize: '.76rem' }}>—</span>;
                };
                return (
                  <tr key={d.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '.5rem' }}>
                      <Link href={`/capability-definitions/${encodeURIComponent(d.id)}`} style={{ fontWeight: 600 }}>{d.title}</Link>
                      <div><code style={{ fontSize: '.72rem', color: 'var(--color-text-faint)' }}>{d.id}</code></div>
                    </td>
                    <td style={{ padding: '.5rem', ...mutedText }}>{d.domain}</td>
                    <td style={{ padding: '.5rem' }}>{cell('oasf')}</td>
                    <td style={{ padding: '.5rem' }}>{cell('hcs26')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p style={{ ...mutedText, fontSize: '.85rem', marginTop: '.8rem' }}>Nothing matches that.</p>}
        </div>
      </div>
    </SectionShell>
  );
}
