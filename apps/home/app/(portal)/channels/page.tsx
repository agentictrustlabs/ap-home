'use client';
// Channels (spec 313 §3) — Slack/Discord-tempo community boards. Membership =
// your current directory listing in the community (the spec 312 opt-in
// artifact): no listing, no channels — joining and being discoverable are the
// same consent. Posts are envelope-shaped and audited before commit.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';

interface ChannelMessage {
  envelope: { id: string; from: string; createdAt: string };
  bodyText: string;
  authorName: string;
}
interface Channel {
  descriptor: { id: string };
  title: string;
  createdBy: string;
  messages: ChannelMessage[];
}

export default function ChannelsPage() {
  const { session } = useSession();
  const [communityId, setCommunityId] = useState('');
  const [joined, setJoined] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cid: string) => {
    if (!session || !cid.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/connect/channels?communityId=${encodeURIComponent(cid.trim().toLowerCase())}`, {
        headers: { authorization: `Bearer ${session.token}` },
      });
      const out = (await res.json()) as { channels?: Channel[]; error?: string };
      if (!res.ok) throw new Error(out.error ?? `failed (${res.status})`);
      setChannels(out.channels ?? []);
      setJoined(cid.trim().toLowerCase());
      setActiveId((prev) => prev ?? out.channels?.[0]?.descriptor.id ?? null);
    } catch (e) {
      setJoined(null);
      setChannels([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session]);

  // Remember the last community across visits (display preference only).
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('channels:community') : null;
    if (saved && session) {
      setCommunityId(saved);
      void load(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const enter = async () => {
    if (typeof window !== 'undefined') window.localStorage.setItem('channels:community', communityId.trim().toLowerCase());
    await load(communityId);
  };

  const act = async (body: Record<string, unknown>) => {
    if (!session || !joined) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ ...body, communityId: joined }),
      });
      const out = (await res.json()) as { ok?: boolean; error?: string; channelId?: string };
      if (!res.ok || !out.ok) throw new Error(out.error ?? `failed (${res.status})`);
      await load(joined);
      if (out.channelId) setActiveId(out.channelId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = channels.find((c) => c.descriptor.id === activeId) ?? null;

  if (!session) {
    return (
      <SectionShell title="Channels">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Channels">
      {error && (
        <p style={{ color: '#b91c1c' }}>
          {error}
          {error.includes('listing') && (
            <> — publish one from <Link href="/you">the You page</Link>.</>
          )}
        </p>
      )}

      <div className="dash-section" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Community id (same one as your directory listing)"
          value={communityId}
          onChange={(e) => setCommunityId(e.target.value)}
          style={{ padding: '0.4rem 0.6rem', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 240 }}
        />
        <button className="btn" disabled={busy || !communityId.trim()} onClick={() => void enter()}>
          {busy ? '…' : 'Enter'}
        </button>
      </div>

      {joined && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: '1rem', alignItems: 'start', marginTop: '1rem' }}>
          <div className="dash-section" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem' }}>
            <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', opacity: 0.6, marginBottom: '0.5rem' }}>#{joined}</div>
            {channels.map((c) => (
              <button
                key={c.descriptor.id}
                onClick={() => setActiveId(c.descriptor.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '0.4rem 0.5rem',
                  border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 0,
                  background: c.descriptor.id === activeId ? '#eef2ff' : '#fff',
                  color: '#111827',
                  fontWeight: c.descriptor.id === activeId ? 600 : 400,
                }}
              >
                # {c.title}
              </button>
            ))}
            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.75rem' }}>
              <input
                placeholder="New channel"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                style={{ flex: 1, padding: '0.3rem 0.5rem', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.8rem' }}
              />
              <button
                className="btn"
                style={{ fontSize: '0.8rem' }}
                disabled={busy || !newTitle.trim()}
                onClick={() => { void act({ action: 'create', title: newTitle.trim() }); setNewTitle(''); }}
              >
                +
              </button>
            </div>
          </div>

          <div className="dash-section" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem', display: 'flex', flexDirection: 'column', minHeight: 380 }}>
            {active ? (
              <>
                <div style={{ fontWeight: 600, borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem' }}># {active.title}</div>
                <div style={{ flex: 1, padding: '0.75rem 0', display: 'flex', flexDirection: 'column', gap: '0.6rem', overflowY: 'auto' }}>
                  {active.messages.length === 0 ? (
                    <p style={{ opacity: 0.6 }}>No posts yet — start the conversation.</p>
                  ) : (
                    active.messages.map((m) => (
                      <div key={m.envelope.id}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{m.authorName}</span>
                        <span style={{ fontSize: '0.7rem', opacity: 0.55, marginLeft: '0.5rem' }}>
                          {new Date(m.envelope.createdAt).toLocaleString()}
                        </span>
                        <div style={{ fontSize: '0.9rem' }}>{m.bodyText}</div>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid #f1f5f9', paddingTop: '0.75rem' }}>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { void act({ action: 'post', channelId: active.descriptor.id, bodyText: draft }); setDraft(''); } }}
                    placeholder={`Message # ${active.title}`}
                    style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 8 }}
                  />
                  <button
                    className="btn"
                    disabled={busy || !draft.trim()}
                    onClick={() => { void act({ action: 'post', channelId: active.descriptor.id, bodyText: draft }); setDraft(''); }}
                  >
                    Post
                  </button>
                </div>
              </>
            ) : (
              <p style={{ opacity: 0.7 }}>No channels yet — create the first one.</p>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
