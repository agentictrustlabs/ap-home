'use client';
// Chats (spec 313) — the Signal-tempo surface: focused person↔person threads.
// Deterministic partition: only pure-'plain', case-free conversations render
// here; requests/approvals stay in the Inbox. Replies route through the same
// audited delivery pipeline as everything else — there is no lighter path.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { useInboxView, agentLabel } from '../../../src/home/use-inbox';

export default function ChatsPage() {
  const { session, agentName } = useSession();
  const { view, post, busy, error, chatConversations } = useInboxView(session);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const activeId = open ?? chatConversations[0]?.conversationId ?? null;
  const active = chatConversations.find((c) => c.conversationId === activeId) ?? null;

  const thread = useMemo(() => {
    if (!view || !activeId) return [];
    return view.items
      .filter((i) => i.conversationId === activeId && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, activeId]);

  const counterpartyName = (conversationId: string): string => {
    // Prefer the resolved agent NAME of the other participant; then the
    // descriptor title; then the short address.
    const d = view?.descriptors[conversationId];
    const other = d?.participants.find((p) => {
      const a = p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
      return a && view?.names?.[a];
    });
    if (other) return agentLabel(other, view?.names);
    if (d?.title) return d.title;
    const firstItem = view?.items.find((i) => i.conversationId === conversationId && i.folder !== 'sent');
    const meta = firstItem ? view?.envelopeMeta[firstItem.messageId] : undefined;
    return meta ? agentLabel(meta.from, view?.names) : 'Conversation';
  };

  const sendReply = async () => {
    if (!activeId || !draft.trim()) return;
    const ok = await post({ action: 'reply', conversationId: activeId, bodyText: draft }, `reply:${activeId}`);
    if (ok) setDraft('');
  };

  if (!session) {
    return (
      <SectionShell title="Chats">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Chats">
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {chatConversations.length === 0 ? (
        <div className="dash-section">
          <p style={{ opacity: 0.75 }}>
            No chats yet. <Link href="/find">Find someone</Link> to start a conversation
            {!agentName && <> — and claim your agent name first so people can reach you</>}.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 280px) 1fr', gap: '1rem', alignItems: 'start' }}>
          {/* chat list */}
          <div className="dash-section" style={{ padding: 0, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            {chatConversations.map((c) => (
              <button
                key={c.conversationId}
                onClick={() => setOpen(c.conversationId)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '0.75rem 0.9rem',
                  border: 'none',
                  borderRadius: 0,
                  borderBottom: '1px solid #f1f5f9',
                  background: c.conversationId === activeId ? '#eef2ff' : '#fff',
                  color: '#111827',
                  fontWeight: 400,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: c.unread > 0 ? 700 : 500, display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span>{counterpartyName(c.conversationId)}</span>
                  {c.unread > 0 && (
                    <span style={{ background: '#4338ca', color: '#fff', borderRadius: 999, fontSize: '0.7rem', padding: '0.05rem 0.45rem' }}>
                      {c.unread}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{new Date(c.lastEventAt).toLocaleString()}</div>
              </button>
            ))}
          </div>

          {/* thread */}
          <div className="dash-section" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem', display: 'flex', flexDirection: 'column', minHeight: 380 }}>
            {active ? (
              <>
                <div style={{ fontWeight: 600, borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem' }}>
                  {counterpartyName(active.conversationId)}
                  {(view?.descriptors[active.conversationId]?.contextRefs ?? []).map((r) => (
                    <span key={`${r.kind}:${r.id}`} style={{ marginLeft: '0.5rem', fontSize: '0.72rem', color: '#4338ca', background: '#eef2ff', borderRadius: 999, padding: '0.1rem 0.6rem' }}>
                      {r.label ?? r.kind}
                    </span>
                  ))}
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 0', overflowY: 'auto' }}>
                  {thread.map((i) => {
                    const meta = view?.envelopeMeta[i.messageId];
                    const mine = i.folder === 'sent';
                    return (
                      <div key={i.messageId} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                        <div
                          style={{
                            background: mine ? '#4338ca' : '#f1f5f9',
                            color: mine ? '#fff' : '#111827',
                            borderRadius: 14,
                            padding: '0.5rem 0.8rem',
                            fontSize: '0.9rem',
                          }}
                        >
                          {view?.bodies[i.messageId] ?? <i>body in vault</i>}
                        </div>
                        <div style={{ fontSize: '0.68rem', opacity: 0.55, marginTop: '0.15rem', textAlign: mine ? 'right' : 'left' }}>
                          {new Date(i.lastEventAt).toLocaleTimeString()}
                          {meta?.signatureSigner ? ' · ✓ signed' : ''}
                          {!mine && i.unread && (
                            <button
                              onClick={() => void post({ action: 'read', messageId: i.messageId }, i.messageId)}
                              style={{ marginLeft: '0.4rem', border: 'none', background: 'none', color: '#4338ca', cursor: 'pointer', fontSize: '0.68rem' }}
                            >
                              mark read
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid #f1f5f9', paddingTop: '0.75rem' }}>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendReply(); }}
                    placeholder="Message…"
                    style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 999 }}
                  />
                  <button className="btn" disabled={busy !== null || !draft.trim()} onClick={() => void sendReply()}>
                    {busy?.startsWith('reply:') ? '…' : 'Send'}
                  </button>
                </div>
              </>
            ) : (
              <p style={{ opacity: 0.7 }}>Select a chat.</p>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
