'use client';
// Find (spec 313 §4) — LinkedIn-tempo discovery, ADR-0025-shaped: exact name
// lookup on the public naming service, opt-in community listings, and YOUR
// trust graph (orgs you steward) as starting points. There is no global
// people search because there is no global roster — by design.
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { useManagedAgents } from '../../../src/components/portal/ManagedAgents';
import { searchAgentsKb, type AgentSearchHit } from '../../../src/lib/agent-search';

interface Listing { label: string; listing: { displayName: string; roles?: string[]; subject: string } }

export default function FindPage() {
  const { session, agentName } = useSession();
  const { agents } = useManagedAgents(session?.token ?? null);
  const orgs = agents.filter((a) => a.kind === 'org');

  const [nameQuery, setNameQuery] = useState('');
  const [nameHits, setNameHits] = useState<AgentSearchHit[] | null>(null);
  const [community, setCommunity] = useState('');
  const [listings, setListings] = useState<Listing[] | null>(null);
  // `name` = FULL agent name (KB hits — may live under any parent, e.g. demo.agent);
  // `label` = bare label under the app's default parent (directory listings).
  const [messageTo, setMessageTo] = useState<{ name?: string; label?: string; display: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Spec 314 W2 — partial match against the discovery knowledge base (the KB the
  // indexer keeps current from on-chain events). One mechanism; no chain fallback.
  const lookupName = useCallback(async () => {
    if (!nameQuery.trim()) return;
    setBusy(true);
    setError(null);
    setNameHits(null);
    try {
      setNameHits(await searchAgentsKb(nameQuery.trim().toLowerCase()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [nameQuery]);

  const browse = useCallback(async (cid: string) => {
    if (!session || !cid.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/connect/directory?communityId=${encodeURIComponent(cid.trim().toLowerCase())}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      const out = (await res.json()) as { listings?: Listing[]; error?: string };
      if (!res.ok) throw new Error(out.error ?? `lookup failed (${res.status})`);
      setListings(out.listings ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session]);

  const sendMessage = useCallback(async () => {
    if (!session || !messageTo || !draft.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/connect/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({
          action: 'send',
          ...(messageTo.name ? { toName: messageTo.name } : { toLabel: messageTo.label }),
          bodyText: draft,
        }),
      });
      const out = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? `send failed (${res.status})`);
      setNote(`Message sent to ${messageTo.display} — the conversation is now in your Chats.`);
      setMessageTo(null);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session, messageTo, draft]);

  if (!session) {
    return (
      <SectionShell title="Find" description="Sign in to find people and organizations.">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  const composer = messageTo && (
    <div className="dash-section" style={{ border: '1px solid #c7d2fe', background: '#eef2ff', borderRadius: 8, padding: '1rem', marginTop: '0.75rem' }}>
      <b>Message {messageTo.display}</b>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void sendMessage(); }}
          placeholder="Say hello…"
          style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 8 }}
        />
        <button className="btn" disabled={busy || !draft.trim()} onClick={() => void sendMessage()}>Send</button>
        <button className="btn" onClick={() => setMessageTo(null)}>Cancel</button>
      </div>
    </div>
  );

  return (
    <SectionShell
      title="Find"
      description="Find people and organizations by name (public naming service) or through communities they chose to be listed in. Nobody appears here without publishing themselves — discovery is consent, not surveillance."
    >
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
      {note && <p style={{ color: '#15803d' }}>{note}</p>}

      {/* Get-discovered prompt (the LinkedIn presence loop, spec 313 §4). */}
      {!agentName && (
        <div className="dash-section" style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8, padding: '1rem' }}>
          <b>You can search, but nobody can find you yet.</b>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.9rem' }}>
            <Link href="/naming">Claim your agent name</Link>, then publish a
            {' '}<Link href="/you">community listing</Link> so people in your circles can discover and message you.
          </p>
        </div>
      )}

      <div className="dash-section" style={{ marginTop: '1rem' }}>
        <h2>By name</h2>
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
          Partial match over the knowledge base — the graph the indexer keeps current from on-chain
          naming, profile, and registry facts. Matches names, display names, descriptions, and skills.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            placeholder="Any part of a name, e.g. sar"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void lookupName(); }}
            style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 220 }}
          />
          <button className="btn" disabled={busy || !nameQuery.trim()} onClick={() => void lookupName()}>Search</button>
        </div>
        {nameHits !== null && (
          <div style={{ marginTop: '0.75rem' }}>
            {nameHits.length === 0 ? (
              <span style={{ opacity: 0.7 }}>No indexed agent matches “{nameQuery.trim()}”. Newly claimed names appear within a minute.</span>
            ) : (
              nameHits.map((h) => (
                <div key={h.smartAgent} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <b>{h.displayName ?? h.name}</b>{' '}
                    <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>({h.name})</span>
                    {h.registryStatus && (
                      <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: '#15803d', background: '#f0fdf4', borderRadius: 999, padding: '0.1rem 0.5rem' }}>
                        {h.registryStatus}
                      </span>
                    )}
                    {(h.description || h.skills) && (
                      <div style={{ fontSize: '0.78rem', opacity: 0.65 }}>
                        {[h.description, h.skills].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div style={{ fontSize: '0.72rem', opacity: 0.5 }}><code>{h.smartAgent}</code></div>
                  </div>
                  <button className="btn" onClick={() => setMessageTo({ name: h.name, display: h.displayName ?? h.name })}>
                    Message
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="dash-section" style={{ marginTop: '1rem' }}>
        <h2>By community</h2>
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
          People who published a listing in a community you share. Opt-in and revocable — no rosters are ever inferred.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            placeholder="Community id"
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void browse(community); }}
            style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 220 }}
          />
          <button className="btn" disabled={busy || !community.trim()} onClick={() => void browse(community)}>Browse</button>
        </div>
        {orgs.length > 0 && (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>Your orgs:</span>
            {orgs.map((o) => {
              const label = o.name.split('.')[0] ?? o.name;
              return (
                <button key={o.agent} className="btn" style={{ fontSize: '0.78rem' }} onClick={() => { setCommunity(label); void browse(label); }}>
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {listings !== null && (
          <div style={{ marginTop: '0.75rem' }}>
            {listings.length === 0 ? (
              <p style={{ opacity: 0.7 }}>
                No listings in this community yet. Be the first — publish yours from <Link href="/you">the You page</Link>.
              </p>
            ) : (
              listings.map((l) => (
                <div key={l.listing.subject} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <b>{l.listing.displayName}</b> <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>({l.label})</span>
                    {(l.listing.roles ?? []).length > 0 && (
                      <div style={{ fontSize: '0.78rem', opacity: 0.65 }}>{(l.listing.roles ?? []).join(' · ')}</div>
                    )}
                  </div>
                  <button className="btn" onClick={() => setMessageTo({ label: l.label, display: l.listing.displayName })}>
                    Message
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {composer}
    </SectionShell>
  );
}
