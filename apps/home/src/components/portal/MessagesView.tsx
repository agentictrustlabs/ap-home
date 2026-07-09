'use client';
// Messages (spec 313 v2) — ONE surface for everything message-shaped, replacing
// the separate Inbox / Chats / Find tabs (Telegram/Slack model): requests
// pinned on top, every conversation in one rail, thread + reply on the right,
// and compose/search built into the header. The chat/request distinction
// stays MECHANICAL (a case attached or not) but is now presentation, not
// navigation. Channels (communities) and Networks (org presence) remain
// separate destinations — different objects, not 1:1 messaging.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { InteractionCaseV1 } from '@agenticprimitives/fabric/interactions';
import { useSession } from '../../context/session';
import { SectionShell } from '../../components/portal/SectionShell';
import { connectWallet, personalSign } from '../../lib/wallet';
import { passkeySignHash, googleSignHash, type SignHash } from '../../connect-client';
import { issueMandateForCase } from '../../home/mandate';
import { activateInboxDeliveryIfNeeded, isKmsVia, type Via } from '../../home/onboarding';
import { DELIVERY_SERVICE_SA } from '../../lib/inbox-delivery';
import { useInboxView, shortId, agentLabel } from '../../home/use-inbox';
import { searchAgentsKb, type AgentSearchHit } from '../../lib/agent-search';

async function signerFor(via: string, agent: Address, token: string): Promise<SignHash> {
  const v = via.toLowerCase();
  if (v === 'wallet') {
    const addr = await connectWallet();
    return (h) => personalSign(addr, h);
  }
  if (v === 'google') return googleSignHash(agent, token);
  return passkeySignHash;
}

// 13→11 reconciliation: delivered/seen are inbox facts now, not case states; a request awaiting the
// responder's decision is `submitted` (received) or `triaged` (being worked).
const PENDING_STATES = ['submitted', 'triaged'];

function ContextChip({ r }: { r: { kind: string; id: string; label?: string } }) {
  // An org-channels invite (spec 318): the chip IS the accept action — it routes the invitee to the
  // org's channels join gate, where they sign their own listing (ADR-0025 — the invite never enrolls).
  if (r.kind === 'org-channels') {
    return (
      <a
        href={`/org/${r.id}/channels`}
        style={{ border: '1px solid #6ee7b7', background: '#ecfdf5', color: '#047857', borderRadius: 999, padding: '0.05rem 0.55rem', fontSize: '0.7rem', textDecoration: 'none', fontWeight: 600 }}
        title={`Organization ${r.id}`}
      >
        {r.label ?? 'Join the discussion'} →
      </a>
    );
  }
  return (
    <span
      style={{ border: '1px solid #c7d2fe', background: '#eef2ff', color: '#4338ca', borderRadius: 999, padding: '0.05rem 0.55rem', fontSize: '0.7rem' }}
      title={`${r.kind}: ${r.id}`}
    >
      {r.label ?? `${r.kind}:${shortId(r.id)}`}
    </span>
  );
}

/**
 * The Interactions/Messages surface (spec 313). `targetAgent` scopes it to a managed org/service SA the
 * person controls (workspace-scoped Messages, spec 315) — the person sees messages sent to THAT agent;
 * omitted → the person's own inbox. The server re-verifies control on every read/action.
 */
export function MessagesView({ targetAgent }: { targetAgent?: Address }) {
  const { session, agentAddress } = useSession();
  const { view, refresh, post, busy, error, setError } = useInboxView(session, targetAgent);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  // Composer: search → pick → write → send.
  const [composeOpen, setComposeOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AgentSearchHit[] | null>(null);
  const [recipient, setRecipient] = useState<AgentSearchHit | null>(null);
  const [composeBody, setComposeBody] = useState('');

  // Vault-storage upgrade (spec 317): existing members provision the standing inbox-delivery grant HERE,
  // by explicit action — the grant is only auto-issued inside enroll flows, and a surprise signature at
  // sign-in is not a consent step (feedback_value_steps_not_signatures). null = still checking / not
  // applicable; false = offer the upgrade; true = vault path active for this member.
  const [vaultBodies, setVaultBodies] = useState<boolean | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  useEffect(() => {
    // Person-scope only: the grant is the PERSON's (delegator = their SA); org/service inboxes are out of
    // scope here. Hidden entirely until the delivery service is provisioned.
    if (!session || !agentAddress || targetAgent || !DELIVERY_SERVICE_SA) return;
    let cancelled = false;
    void fetch(`/connect/inbox/delivery-grant?owner=${agentAddress}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
      .then((r) => r.json())
      .then((d: { stored?: boolean }) => { if (!cancelled) setVaultBodies(d.stored === true); })
      .catch(() => { /* leave null — no banner on a read hiccup */ });
    return () => { cancelled = true; };
  }, [session, agentAddress, targetAgent]);

  const enableVaultBodies = useCallback(async () => {
    if (!session || !agentAddress) return;
    setVaultBusy(true);
    try {
      const via = session.via as Via;
      const r = await activateInboxDeliveryIfNeeded(agentAddress as Address, via, isKmsVia(via) ? { token: session.token } : undefined);
      if (r.ok) setVaultBodies(true);
      else setError(r.error);
    } finally { setVaultBusy(false); }
  }, [session, agentAddress, setError]);

  // DM deep-link (`/messages?to=<label>`, e.g. from an org channel's "Message" button): resolve the
  // label through the SAME KB search the composer uses (one mechanism, spec 314) and open compose
  // with the recipient picked. window.location (not useSearchParams) — no Suspense boundary needed.
  useEffect(() => {
    const to = new URLSearchParams(window.location.search).get('to')?.trim().toLowerCase();
    if (!to) return;
    let cancelled = false;
    void searchAgentsKb(to).then((found) => {
      if (cancelled || found.length === 0) return;
      const hit = found.find((h) => h.label.toLowerCase() === to) ?? found[0]!;
      setRecipient(hit);
      setComposeOpen(true);
    }).catch(() => { /* unresolved label → the user just gets the normal composer */ });
    return () => { cancelled = true; };
  }, []);

  const conversations = useMemo(
    () => [...(view?.conversations ?? [])].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)),
    [view],
  );
  const activeId = open ?? conversations[0]?.conversationId ?? null;

  const thread = useMemo(() => {
    if (!view || !activeId) return [];
    return view.items
      .filter((i) => i.conversationId === activeId && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, activeId]);

  // Pending case attached to a conversation (what makes it a "request" thread).
  const caseFor = useCallback(
    (conversationId: string): InteractionCaseV1 | null => {
      if (!view) return null;
      const ids = new Set(view.items.filter((i) => i.conversationId === conversationId).map((i) => i.interactionId).filter(Boolean));
      return view.cases.find((c) => ids.has(c.id)) ?? null;
    },
    [view],
  );
  const pendingCases = useMemo(() => (view?.cases ?? []).filter((c) => PENDING_STATES.includes(c.state)), [view]);
  const convForCase = useCallback(
    (c: InteractionCaseV1): string | null =>
      view?.items.find((i) => i.interactionId === c.id)?.conversationId ?? null,
    [view],
  );

  const titleFor = useCallback(
    (conversationId: string): string => {
      const d = view?.descriptors[conversationId];
      const other = d?.participants.find((p) => {
        const a = p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
        return a && view?.names?.[a];
      });
      if (other) return agentLabel(other, view?.names);
      if (d?.title) return d.title;
      const firstIn = view?.items.find((i) => i.conversationId === conversationId && i.folder !== 'sent');
      const meta = firstIn ? view?.envelopeMeta[firstIn.messageId] : undefined;
      return meta?.subject ?? (meta ? agentLabel(meta.from, view?.names) : 'Conversation');
    },
    [view],
  );

  // Opening a thread reads it (Telegram behavior) — no explicit "mark read".
  useEffect(() => {
    if (!view || !activeId) return;
    const unread = view.items.filter((i) => i.conversationId === activeId && i.unread && i.folder !== 'sent');
    for (const i of unread) void post({ action: 'read', messageId: i.messageId }, `read:${i.messageId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, view?.summary.unreadTotal]);

  const activeDescriptor = activeId ? view?.descriptors[activeId] : undefined;
  const canReply = !!activeDescriptor && activeDescriptor.participants.length === 2;
  const activeCase = activeId ? caseFor(activeId) : null;
  const activePending = !!activeCase && PENDING_STATES.includes(activeCase.state);

  const sendReply = async () => {
    if (!activeId || !draft.trim()) return;
    const ok = await post({ action: 'reply', conversationId: activeId, bodyText: draft }, `reply:${activeId}`);
    if (ok) setDraft('');
  };

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setError(null);
    setHits(null);
    try {
      setHits(await searchAgentsKb(query.trim().toLowerCase()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [query, setError]);

  const sendNew = async () => {
    if (!recipient || !composeBody.trim()) return;
    const ok = await post({ action: 'send', toName: recipient.name, bodyText: composeBody }, 'compose');
    if (ok) {
      setComposeOpen(false);
      setRecipient(null);
      setComposeBody('');
      setQuery('');
      setHits(null);
      await refresh();
    }
  };

  const approveWithMandate = useCallback(
    async (c: InteractionCaseV1) => {
      if (!session || !agentAddress) return;
      setLocalBusy(true);
      setError(null);
      try {
        const sign = await signerFor(session.via, agentAddress as Address, session.token);
        const { mandate } = await issueMandateForCase(c, agentAddress as Address, sign);
        await post({ action: 'transition', transition: 'approve', interactionId: c.id, mandate }, c.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLocalBusy(false);
      }
    },
    [session, agentAddress, post, setError],
  );

  const anyBusy = busy !== null || localBusy;

  if (!session) {
    return (
      <SectionShell title="Messages">
        <p>Not signed in.</p>
      </SectionShell>
    );
  }

  const caseActions = (c: InteractionCaseV1) => {
    const card = view?.cards[c.id];
    const actions = card?.allowedActions ?? [
      { actionId: 'approve', label: 'Approve', transition: 'approve' as const, style: 'primary' as const },
      { actionId: 'deny', label: 'Deny', transition: 'deny' as const, style: 'destructive' as const },
    ];
    return actions.map((a) => {
      const issues = a.transition === 'approve' && c.kind === 'access-request';
      return (
        <button
          key={a.actionId}
          style={a.style === 'destructive' ? { background: '#fee2e2', color: '#b91c1c' } : undefined}
          disabled={anyBusy}
          title={issues ? 'Signs a scoped delegation + mandate' : undefined}
          onClick={() =>
            issues
              ? void approveWithMandate(c)
              : void post({ action: 'transition', interactionId: c.id, transition: a.transition }, c.id)
          }
        >
          {busy === c.id ? '…' : issues ? `${a.label} + issue mandate` : a.label}
        </button>
      );
    });
  };

  return (
    <SectionShell title="Messages">
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}

      {/* ── Needs attention: pending requests pinned above the rail ── */}
      {pendingCases.length > 0 && (
        <div style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 10, padding: '0.9rem 1rem', marginBottom: '1rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.5rem' }}>Needs attention · {pendingCases.length}</div>
          {pendingCases.map((c) => {
            const card = view?.cards[c.id];
            return (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.6rem 0.8rem', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: '0.4rem' }}>
                <div>
                  <b>{card?.title ?? c.subject}</b>
                  <div style={{ fontSize: '0.82rem', opacity: 0.75 }}>
                    {card?.summary ?? `${c.kind} · from ${agentLabel(c.requester, view?.names)}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  {caseActions(c)}
                  {convForCase(c) && (
                    <button className="ghost" onClick={() => setOpen(convForCase(c))}>Open thread</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Vault-storage upgrade (spec 317) — explicit consent, one signature, once ── */}
      {vaultBodies === false && (
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', border: '1px solid #6ee7b7', background: '#ecfdf5', borderRadius: 10, padding: '0.5rem 0.8rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.83rem', color: '#065f46' }}>
            <b>Secure your message storage.</b> Store message contents encrypted in your personal vault instead
            of app storage — you sign one standing authorization your Home can never widen.
          </span>
          <button className="btn" disabled={vaultBusy} onClick={() => void enableVaultBodies()}>
            {vaultBusy ? 'Signing…' : 'Enable vault storage'}
          </button>
        </div>
      )}

      {/* ── Header: search + new message ── */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input
          placeholder="Search people (any part of a name)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setComposeOpen(true); void runSearch(); } }}
          style={{ flex: 1, minWidth: 220, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 999 }}
        />
        <button disabled={!query.trim()} onClick={() => { setComposeOpen(true); void runSearch(); }}>Search</button>
        <button className="ghost" onClick={() => { setComposeOpen((v) => !v); setHits(null); }}>
          {composeOpen ? 'Close' : 'New message'}
        </button>
      </div>

      {/* ── Composer (search → pick → write) ── */}
      {composeOpen && (
        <div style={{ border: '1px solid #c7d2fe', background: '#eef2ff', borderRadius: 10, padding: '1rem', marginBottom: '1rem' }}>
          {!recipient ? (
            <>
              <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                To: search the knowledge base — matches names, display names, descriptions, skills.
              </div>
              {hits === null ? (
                <div style={{ fontSize: '0.82rem', opacity: 0.65 }}>Type above and hit Search.</div>
              ) : hits.length === 0 ? (
                <div style={{ fontSize: '0.82rem', opacity: 0.65 }}>No indexed agent matches “{query.trim()}”. Newly claimed names appear within a minute.</div>
              ) : (
                hits.map((h) => (
                  <div key={h.smartAgent} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.5rem 0', borderBottom: '1px solid #e0e7ff', flexWrap: 'wrap', alignItems: 'center' }}>
                    <div>
                      <b>{h.displayName ?? h.name}</b> <span style={{ opacity: 0.6, fontSize: '0.82rem' }}>({h.name})</span>
                      {(h.description || h.skills) && (
                        <div style={{ fontSize: '0.76rem', opacity: 0.65 }}>{[h.description, h.skills].filter(Boolean).join(' · ')}</div>
                      )}
                    </div>
                    <button onClick={() => setRecipient(h)}>Select</button>
                  </div>
                ))
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                To: <b>{recipient.displayName ?? recipient.name}</b>{' '}
                <span style={{ opacity: 0.6 }}>({recipient.name})</span>{' '}
                <button className="ghost" style={{ fontSize: '0.75rem', minHeight: 0, padding: '0.15rem 0.5rem' }} onClick={() => setRecipient(null)}>change</button>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  value={composeBody}
                  onChange={(e) => setComposeBody(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void sendNew(); }}
                  placeholder="Write your message…"
                  autoFocus
                  style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 8 }}
                />
                <button disabled={anyBusy || !composeBody.trim()} onClick={() => void sendNew()}>
                  {busy === 'compose' ? '…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Rail + thread ── */}
      {conversations.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No conversations yet — search a name above and send the first message.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 290px) 1fr', gap: '1rem', alignItems: 'start' }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            {conversations.map((c) => {
              const cCase = caseFor(c.conversationId);
              const isPending = !!cCase && PENDING_STATES.includes(cCase.state);
              return (
                <button
                  key={c.conversationId}
                  onClick={() => setOpen(c.conversationId)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '0.7rem 0.9rem',
                    border: 'none', borderRadius: 0, borderBottom: '1px solid #f1f5f9', minHeight: 0,
                    background: c.conversationId === activeId ? '#eef2ff' : '#fff',
                    color: '#111827', fontWeight: 400, cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontWeight: c.unread > 0 ? 700 : 500 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{titleFor(c.conversationId)}</span>
                    {c.unread > 0 && (
                      <span style={{ background: '#4338ca', color: '#fff', borderRadius: 999, fontSize: '0.68rem', padding: '0.05rem 0.45rem', alignSelf: 'center' }}>
                        {c.unread}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.6, display: 'flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.15rem' }}>
                    {isPending && <span style={{ color: '#b45309', fontWeight: 700 }}>● needs review</span>}
                    <span>{new Date(c.lastEventAt).toLocaleString()}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '1rem', display: 'flex', flexDirection: 'column', minHeight: 420 }}>
            {activeId ? (
              <>
                <div style={{ fontWeight: 600, borderBottom: '1px solid #f1f5f9', paddingBottom: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {titleFor(activeId)}
                  {(view?.descriptors[activeId]?.contextRefs ?? []).map((r) => <ContextChip key={`${r.kind}:${r.id}`} r={r} />)}
                </div>

                {/* Request thread: the decision card lives IN the thread. */}
                {activeCase && activePending && (
                  <div style={{ margin: '0.75rem 0 0', padding: '0.75rem 0.9rem', border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8 }}>
                    <b>{view?.cards[activeCase.id]?.title ?? activeCase.subject}</b>
                    <div style={{ fontSize: '0.82rem', opacity: 0.75, margin: '0.2rem 0 0.5rem' }}>
                      {view?.cards[activeCase.id]?.summary ?? `${activeCase.kind} · from ${agentLabel(activeCase.requester, view?.names)}`}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>{caseActions(activeCase)}</div>
                  </div>
                )}
                {activeCase && !activePending && (
                  <div style={{ margin: '0.75rem 0 0', fontSize: '0.78rem', color: '#475569' }}>
                    Request state: <b>{activeCase.state}</b>
                    {view?.mandates[activeCase.id] && <> · mandate issued (delegation <code>{view.mandates[activeCase.id]!.delegationHash.slice(0, 10)}…</code>)</>}
                  </div>
                )}

                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 0', overflowY: 'auto' }}>
                  {thread.map((i) => {
                    const meta = view?.envelopeMeta[i.messageId];
                    const mine = i.folder === 'sent';
                    return (
                      <div key={i.messageId} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                        <div style={{ background: mine ? '#4338ca' : '#f1f5f9', color: mine ? '#fff' : '#111827', borderRadius: 14, padding: '0.5rem 0.8rem', fontSize: '0.9rem' }}>
                          {view?.bodies[i.messageId] ?? <i>body in vault</i>}
                        </div>
                        <div style={{ fontSize: '0.68rem', opacity: 0.55, marginTop: '0.15rem', textAlign: mine ? 'right' : 'left' }}>
                          {!mine && meta && <>{agentLabel(meta.from, view?.names)} · </>}
                          {new Date(i.lastEventAt).toLocaleTimeString()}
                          {meta?.signatureSigner ? ' · ✓ signed' : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {canReply ? (
                  <div style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid #f1f5f9', paddingTop: '0.75rem' }}>
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void sendReply(); }}
                      placeholder="Message…"
                      style={{ flex: 1, padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: 999 }}
                    />
                    <button disabled={anyBusy || !draft.trim()} onClick={() => void sendReply()}>
                      {busy === `reply:${activeId}` ? '…' : 'Send'}
                    </button>
                  </div>
                ) : (
                  <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '0.6rem', fontSize: '0.75rem', opacity: 0.6 }}>
                    {activeCase ? 'Respond with the request actions above.' : 'Replies open once the conversation has a two-party descriptor.'}
                  </div>
                )}
              </>
            ) : (
              <p style={{ opacity: 0.7 }}>Select a conversation.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Issued mandates ── */}
      {view && Object.keys(view.mandates).length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <h2 style={{ fontSize: '0.85rem' }}>Issued mandates</h2>
          {Object.entries(view.mandates).map(([intId, m]) => {
            const c = view.cases.find((x) => x.id === intId);
            return (
              <div key={m.mandateId} style={{ padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.82rem' }}>
                <b>{c?.subject ?? intId}</b>
                <div style={{ opacity: 0.7 }}>
                  {m.allowedActions.join(', ')} · {m.resourceScope.resource}
                  {m.constraints.expiresAt ? ` · until ${new Date(m.constraints.expiresAt).toLocaleDateString()}` : ''}
                  {' · delegation '}<code>{m.delegationHash.slice(0, 10)}…</code>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionShell>
  );
}

