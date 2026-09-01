'use client';
// One capability definition, and everything asserted about it (ADR-0051). Read-only.
import { use } from 'react';
import Link from 'next/link';
import { getCapabilityDefinition, mappingsFor, OASF_VERSION, HCS26_VERSION } from '@agenticprimitives/capability-claims';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { cardSty, mutedText, mono } from '../../../../src/components/portal/theme';

export default function CapabilityDefinitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = decodeURIComponent(raw);
  const def = getCapabilityDefinition(id);
  const mappings = mappingsFor(id);

  if (!def) {
    return (
      <SectionShell title="Capability definition" description="">
        <div style={cardSty}>
          <p>No definition with the id <code style={mono as React.CSSProperties}>{id}</code>.</p>
          <p style={{ ...mutedText, fontSize: '.84rem' }}>
            An agent may still be publishing this id — a claim and a definition are different things, and an
            id with no definition is exactly what the Capabilities page flags as “not in catalog”.
          </p>
          <Link href="/capability-definitions">← All definitions</Link>
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell title={def.title} description={def.description}>
      <div style={{ ...cardSty, marginBottom: '1rem' }}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.35rem .8rem', margin: 0, fontSize: '.85rem' }}>
          <dt style={mutedText}>Id</dt><dd style={{ margin: 0 }}><code style={mono as React.CSSProperties}>{def.id}</code></dd>
          <dt style={mutedText}>Version</dt><dd style={{ margin: 0 }}>{def.version}</dd>
          <dt style={mutedText}>Domain</dt><dd style={{ margin: 0 }}>{def.domain}</dd>
          <dt style={mutedText}>Kind</dt><dd style={{ margin: 0 }}>{def.kind === 'substrate' ? 'Performed by this software' : 'Professional service'}</dd>
        </dl>
        <p style={{ ...mutedText, fontSize: '.8rem', marginTop: '.7rem' }}>
          To claim this, open <Link href="/capabilities">Capabilities</Link> in the workspace of the agent
          that does it. Claiming is per-agent; the definition is shared.
        </p>
      </div>

      <div style={cardSty}>
        <h3 style={{ marginTop: 0, fontSize: '.95rem' }}>Taxonomy mappings</h3>
        <p style={{ ...mutedText, fontSize: '.8rem', marginTop: 0 }}>
          Where this sits in taxonomies other people use. A mapping is an assertion, so each carries who
          made it, at which taxonomy version, and what it is evidenced by.
        </p>
        {mappings.length === 0 ? (
          // Saying nothing is the honest outcome. A plausible-looking class id invented to fill this
          // table would read as authority to anything that consumed it.
          <p style={{ fontSize: '.85rem' }}>
            No mapping at this taxonomy version — <span style={mutedText}>OASF {OASF_VERSION}, HCS-26 {HCS26_VERSION}</span>.
            Nothing published could be cited for this capability, and an uncitable mapping is worse than none.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.83rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-faint)', fontSize: '.72rem', textTransform: 'uppercase' }}>
                <th style={{ padding: '.35rem .4rem' }}>Taxonomy</th><th style={{ padding: '.35rem .4rem' }}>Version</th>
                <th style={{ padding: '.35rem .4rem' }}>Target class</th><th style={{ padding: '.35rem .4rem' }}>Relation</th>
                <th style={{ padding: '.35rem .4rem' }}>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m, i) => (
                <tr key={`${m.taxonomy}-${i}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '.4rem' }}>{m.taxonomy}</td>
                  <td style={{ padding: '.4rem', ...mutedText }}>{m.taxonomyVersion}</td>
                  <td style={{ padding: '.4rem' }}><code style={{ fontSize: '.76rem' }}>{m.targetClassId}</code></td>
                  <td style={{ padding: '.4rem' }}>{m.relation}</td>
                  <td style={{ padding: '.4rem' }}>
                    {(m.evidence ?? []).map((e, j) => (
                      <a key={j} href={e.ref} target="_blank" rel="noreferrer" style={{ fontSize: '.76rem' }}>{e.kind}</a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ marginTop: '1rem' }}><Link href="/capability-definitions">← All definitions</Link></p>
    </SectionShell>
  );
}
