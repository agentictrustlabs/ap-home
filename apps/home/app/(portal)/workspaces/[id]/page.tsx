'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useSession } from '../../../../src/context/session';
import { SectionShell } from '../../../../src/components/portal/SectionShell';
import { listMyOrgs, type MyOrg } from '../../../../src/connect-client';
import { workspaceById } from '../../../../src/lib/app-workspaces';

interface ListingHost {
  org: string;
  orgName: string;
  stewardName: string;
  joinedAt: string;
}

export default function WorkspaceDetailPage() {
  const params = useParams<{ id: string }>();
  const workspace = workspaceById(String(params.id ?? ''));
  const { session } = useSession();
  const [mine, setMine] = useState<MyOrg[]>([]);
  const [hosts, setHosts] = useState<ListingHost[]>([]);
  const [listingError, setListingError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.token) return;
    let cancelled = false;
    void listMyOrgs(session.token, 'roster')
      .then((o) => {
        if (!cancelled) setMine(o.filter((x) => (x.kind ?? 'org') === 'org'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void fetch(`${workspace.listingHref.replace(/\/$/, '')}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ws',
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'workspace listing' }], metadata: { skill: 'gather.workspace' } } },
      }),
    })
      .then(async (r) => {
        const body = (await r.json()) as { result?: { hosts?: ListingHost[] }; error?: { message?: string } };
        if (!r.ok || body.error) throw new Error(body.error?.message ?? `listing ${r.status}`);
        if (!cancelled) setHosts(body.result?.hosts ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListingError(e instanceof Error ? e.message : 'listing unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  if (!workspace) {
    return (
      <SectionShell title="Workspace">
        <p>Unknown workspace. <Link href="/workspaces">Back to workspaces</Link></p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title={workspace.name} description={workspace.blurb}>
      <p style={{ marginBottom: '1rem' }}>
        <a href={workspace.appHref} target="_blank" rel="noreferrer">
          Open {workspace.name} ↗
        </a>
        {' · '}
        <Link href="/workspaces">All workspaces</Link>
      </p>
      <h3 style={{ margin: '1.25rem 0 0.5rem', fontSize: '0.95rem' }}>Organizations on this listing</h3>
      {listingError && <p style={{ color: 'var(--color-danger)' }}>{listingError}</p>}
      {hosts.length === 0 && !listingError && <p style={{ color: 'var(--color-muted)' }}>No host organizations have registered yet. Invitees who complete onboarding appear here.</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {hosts.map((h) => (
          <li key={h.org} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.7rem 0.9rem' }}>
            <strong>{h.orgName}</strong>
            <div style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
              Steward {h.stewardName} · {h.org}
            </div>
          </li>
        ))}
      </ul>
      <h3 style={{ margin: '1.5rem 0 0.5rem', fontSize: '0.95rem' }}>Organizations you belong to</h3>
      <p style={{ color: 'var(--color-muted)', fontSize: '0.9rem' }}>
        After an invite redeem, membership is already recorded at Home. Those orgs show here and in the switcher.
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {mine.map((o) => (
          <li key={o.orgAgent} style={{ padding: '0.35rem 0' }}>
            {o.orgName || o.orgAgent} · {o.relationship ?? 'member'}
          </li>
        ))}
        {mine.length === 0 && <li style={{ color: 'var(--color-muted)' }}>None yet.</li>}
      </ul>
    </SectionShell>
  );
}
