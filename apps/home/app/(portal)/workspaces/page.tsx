'use client';

import Link from 'next/link';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { APP_WORKSPACES } from '../../../src/lib/app-workspaces';

export default function WorkspacesPage() {
  return (
    <SectionShell
      title="Workspaces"
      description="App-scoped listings of membership organizations. Distinct from the organization you steward — a workspace is who an app admits via invite and register."
    >
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
        {APP_WORKSPACES.map((w) => (
          <li
            key={w.id}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-8)',
              padding: '1rem 1.1rem',
              background: 'var(--color-surface)',
            }}
          >
            <Link href={`/workspaces/${w.id}`} style={{ fontWeight: 700, fontSize: '1.05rem' }}>
              {w.name}
            </Link>
            <p style={{ margin: '0.4rem 0 0', color: 'var(--color-muted)', fontSize: '0.92rem' }}>{w.blurb}</p>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}
