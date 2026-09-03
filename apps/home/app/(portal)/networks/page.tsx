'use client';
// Networks (spec 313 §4) — LinkedIn/Discord-tempo org presence. Your named
// orgs publish a signed listing into the reserved `networks` index so other
// orgs can find them and reach their inbox. The publish gate verifies the
// listing signature against the ORG SA — a steward can list only orgs their
// credential actually controls. Revoke = re-publish with an immediate expiry.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { sendMessage, MessagingWireRequiredError } from '../../../src/lib/messaging-send';
import { ApproveMessaging } from '../../../src/components/portal/ApproveMessaging';
import { agentNameForLabel } from '../../../src/lib/domain';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { useManagedAgents } from '../../../src/components/portal/ManagedAgents';
import { issueDirectoryListing } from '../../../src/home/directory';
import { signHashFor, type Via } from '../../../src/home/onboarding';
import { agentClassOf } from '../../../src/lib/agent-class';

const NETWORKS_INDEX = 'networks';

interface Listing { label: string; listing: { displayName: string; roles?: string[]; subject: string } }

export default function NetworksPage() {
  const { session, agentAddress, profile } = useSession();
  // spec 341 §5.1b — a send the person can unblock with one signature, kept apart from real errors.
  const [wireNeeded, setWireNeeded] = useState<MessagingWireRequiredError | null>(null);
  const { agents } = useManagedAgents(session?.token ?? null);
  const orgs = agents.filter((a) => agentClassOf(a.kind) === 'org' && a.name);

  const [listings, setListings] = useState<Listing[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string>('');
  const [pitch, setPitch] = useState('');
  const [contactOrg, setContactOrg] = useState<Listing | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch(`/connect/directory?communityId=${NETWORKS_INDEX}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      const out = (await res.json()) as { listings?: Listing[] };
      if (res.ok) setListings(out.listings ?? []);
    } catch {
      /* surfaced on action paths */
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const publishOrg = useCallback(async () => {
    if (!session || !agentAddress || !selectedOrg) return;
    const org = orgs.find((o) => o.agent === selectedOrg);
    if (!org) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const sign = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, { token: session.token });
      const listing = await issueDirectoryListing(agentAddress as Address, sign, {
        communityId: NETWORKS_INDEX,
        displayName: org.name.split('.')[0] ?? org.name,
        roles: pitch.trim() ? [pitch.trim()] : undefined,
        subject: org.agent as Address,
        contextKind: 'network',
        visibility: 'public',
      });
      const res = await fetch('/connect/directory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'publish', listing }),
      });
      const out = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? `publish failed (${res.status})`);
      setNote(`${org.name} is now discoverable in Networks.`);
      setPitch('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, agentAddress, selectedOrg, orgs, pitch, refresh]);

  const contact = useCallback(async () => {
    if (!session || !contactOrg || !draft.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // spec 341 §5.1b — the person's own agent delivers this over A2A, under a wire they signed.
      if (!agentAddress) throw new Error('no agent address');
      await sendMessage({
        person: agentAddress,
        recipientName: agentNameForLabel(contactOrg.label),
        subject: `Collaboration inquiry — ${contactOrg.listing.displayName}`,
        bodyText: draft,
        contextRefs: [{ kind: 'network', id: NETWORKS_INDEX }],
      });
      setNote(`Inquiry delivered to ${contactOrg.listing.displayName}'s inbox.`);
      setContactOrg(null);
      setDraft('');
    } catch (e) {
      // The one failure a signature fixes, kept separate so it renders as an action.
      if (e instanceof MessagingWireRequiredError) setWireNeeded(e);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, contactOrg, draft, agentAddress]);

  if (!session) {
    return (
      <SectionShell title="Networks">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  const myOrgAddrs = new Set(orgs.map((o) => o.agent.toLowerCase()));

  return (
    <SectionShell title="Networks" description="Your named organizations, published for discovery — other orgs can find them and reach their inbox.">
      <ApproveMessaging
        need={wireNeeded}
        person={agentAddress ?? null}
        session={session}
        credential={profile?.credential}
        onApproved={() => setWireNeeded(null)}
        onError={setError}
      />
      {error && <p style={{ color: 'var(--color-danger)', fontSize: '.85rem' }}>{error}</p>}
      {note && <p style={{ color: 'var(--color-sage-700)', fontSize: '.85rem' }}>{note}</p>}

      <div className="dash-section">
        <h2>Publish your organization</h2>
        {orgs.length === 0 ? (
          <p className="manage-card-blurb">
            You don&apos;t steward a named organization yet. <Link href="/agents">Create one</Link> — every
            org is named (that&apos;s what makes it reachable), then publish it here.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.5rem', maxWidth: 520 }}>
            <select
              value={selectedOrg}
              onChange={(e) => setSelectedOrg(e.target.value)}
              style={{ padding: '0.5rem 0.7rem', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-8)', font: 'inherit', background: 'var(--color-surface)' }}
            >
              <option value="">Choose an organization…</option>
              {orgs.map((o) => (
                <option key={o.agent} value={o.agent}>{o.name}</option>
              ))}
            </select>
            <input
              placeholder="What does it do? (one line, shows on the listing)"
              value={pitch}
              onChange={(e) => setPitch(e.target.value)}
              style={{ padding: '0.5rem 0.7rem', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-8)', font: 'inherit' }}
            />
            <div>
              <button className="btn-primary" style={{ width: 'auto' }} disabled={busy || !selectedOrg} onClick={() => void publishOrg()}>
                {busy ? 'Signing…' : 'Publish to Networks'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="dash-section" style={{ marginTop: '1.5rem' }}>
        <h2>Organizations ({listings.length})</h2>
        {listings.length === 0 ? (
          <p className="manage-card-blurb">No organizations have published yet — yours could be first.</p>
        ) : (
          listings.map((l) => {
            const mine = myOrgAddrs.has((l.listing.subject.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase());
            return (
              <div key={l.listing.subject} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.7rem 0', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <b>{l.listing.displayName}</b> <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>({l.label})</span>
                  {mine && <span className="manage-card-badge live" style={{ marginLeft: '0.5rem' }}>yours</span>}
                  {(l.listing.roles ?? []).length > 0 && (
                    <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>{(l.listing.roles ?? []).join(' · ')}</div>
                  )}
                </div>
                {!mine && (
                  <button className="btn-ghost" style={{ width: 'auto' }} onClick={() => setContactOrg(l)}>Contact</button>
                )}
              </div>
            );
          })
        )}
      </div>

      {contactOrg && (
        <div className="dash-section chat-attention" style={{ marginTop: '0.75rem' }}>
          <b>Contact {contactOrg.listing.displayName}</b>
          <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', margin: '0.25rem 0 0.5rem' }}>
            Delivered to the organization&apos;s own inbox through the audited pipeline — signed shape, on-chain name check.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void contact(); }}
              placeholder="Introduce your org and what you'd like to explore together…"
              style={{ flex: 1, minWidth: 200, padding: '0.55rem 0.8rem', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-8)', font: 'inherit' }}
            />
            <button className="btn-primary" style={{ width: 'auto' }} disabled={busy || !draft.trim()} onClick={() => void contact()}>Send</button>
            <button className="btn-ghost" style={{ width: 'auto' }} onClick={() => setContactOrg(null)}>Cancel</button>
          </div>
        </div>
      )}
    </SectionShell>
  );
}
