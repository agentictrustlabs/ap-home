'use client';
// Messages (spec 313 v2) — Telegram/Outlook-style unified inbox: requests pinned,
// conversation rail + thread, rich compose (emoji + images), amber design system.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { InteractionCaseV1 } from '@agenticprimitives/fabric/interactions';
import { useSession } from '../../context/session';
import { SectionShell } from '../../components/portal/SectionShell';
import { issueMandateForCase } from '../../home/mandate';
import { signHashFor, type Via } from '../../home/onboarding';
import { useInboxView, shortId, agentLabel } from '../../home/use-inbox';
import { searchAgentsKb, type AgentSearchHit } from '../../lib/agent-search';
import { personAvatarKey, setPersonAvatar } from '../../lib/avatar-store';
import { AvatarUpload } from './chat/AvatarUpload';
import { useMessagingDelivery } from './agent/AgentTab';
import { MessageBubble } from './chat/MessageBubble';
import { MessageComposer } from './chat/MessageComposer';
import { messagePreview } from './chat/message-content';
import { useAvatar } from './chat/use-avatar';
import { useManagedAgents } from './ManagedAgents';
import { ApproveMessaging } from './ApproveMessaging';
import { MessagingWireRequiredError } from '../../lib/messaging-send';
import { isAllowedRelyingOrigin } from '../../lib/oidc-clients';


const PENDING_STATES = ['submitted', 'triaged'];

function ContextChip({ r, names }: { r: { kind: string; id: string; label?: string }; names?: Record<string, string> }) {
  if (r.kind === 'discussion-topic') {
    // Restricted-topic invitation (tbox/messaging.ttl §Topic participation): the id is
    // `<orgSA>/<topicId>`. "Join discussion" converts the invitation into a DiscussionParticipation
    // (channels.acceptInvite) and deep-links to the org's Discussions.
    return <JoinDiscussionChip refId={r.id} label={r.label} names={names} />;
  }
  if (r.kind === 'endeavor') {
    // spec 334 §9 — the endeavor chip mirrors the discussion-topic invite chip:
    // id is `<managingPrincipalSA>/<endeavorId>`, deep-linking to the org Work
    // endeavor detail. A pointer only — never authority.
    const [principal = '', endeavorId = ''] = r.id.split('/');
    const orgName = names?.[principal.toLowerCase()];
    return (
      <a
        href={`/org/${principal.toLowerCase()}/work/${encodeURIComponent(endeavorId)}`}
        className="badge"
        style={{ border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)', textDecoration: 'none', fontWeight: 600 }}
        title={`Endeavor${orgName ? ` at ${orgName}` : ''}: ${r.label ?? endeavorId}`}
      >
        {r.label ?? 'View endeavor'} →
      </a>
    );
  }
  if (r.kind === 'org-channels') {
    // Name the ORG on the chip — a thread can carry invites to DIFFERENT orgs (contextRefs union),
    // and generic "Join the organization" chips were indistinguishable.
    const orgName = names?.[r.id.toLowerCase()];
    return (
      <a
        href={`/org/${r.id}/discussions`}
        className="badge"
        style={{ border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)', textDecoration: 'none', fontWeight: 600 }}
        title={`Organization ${orgName ?? r.id}`}
      >
        {orgName ? `Join ${orgName}` : (r.label ?? 'Join the discussion')} →
      </a>
    );
  }
  return (
    <span className="badge" style={{ border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50)', color: 'var(--color-amber-700)' }} title={`${r.kind}: ${r.id}`}>
      {r.label ?? `${r.kind}:${shortId(r.id)}`}
    </span>
  );
}

function JoinDiscussionChip({ refId, label, names }: { refId: string; label?: string; names?: Record<string, string> }) {
  const { session } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'joined' | 'error'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [org = '', topicId = ''] = refId.split('/');
  const orgName = names?.[org.toLowerCase()];
  const join = useCallback(async () => {
    if (!session || !org || !topicId) return;
    setState('busy'); setNote(null);
    try {
      const res = await fetch('/connect/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ action: 'acceptInvite', communityId: org, channelId: topicId }),
      });
      const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !b.ok) throw new Error(b.error ?? `join failed (${res.status})`);
      setState('joined');
      window.location.href = `/org/${org}/discussions`;
    } catch (e) {
      setState('error'); setNote(e instanceof Error ? e.message : String(e));
    }
  }, [session, org, topicId]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
      <button
        type="button"
        className="badge"
        onClick={() => void join()}
        disabled={state === 'busy' || state === 'joined'}
        style={{ border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)', fontWeight: 600, cursor: 'pointer' }}
        title={`Restricted discussion topic${orgName ? ` in ${orgName}` : ''}`}
      >
        {state === 'busy' ? 'Joining…' : state === 'joined' ? 'Joined ✓' : `Join discussion${label ? `: ${label}` : ''} →`}
      </button>
      {note && <span style={{ fontSize: '0.72rem', color: 'var(--color-danger)' }}>{note}</span>}
    </span>
  );
}

function ConvAvatar({ conversationId, title, view }: { conversationId: string; title: string; view: ReturnType<typeof useInboxView>['view'] }) {
  const addr = useMemo(() => {
    const d = view?.descriptors[conversationId];
    const p = d?.participants.find((x) => {
      const a = x.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
      return a && view?.names?.[a];
    });
    return p?.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
  }, [conversationId, view]);
  const imageUrl = useAvatar(addr ? personAvatarKey(addr) : null);
  return <AvatarUpload name={title} imageUrl={imageUrl} size={48} />;
}

export function MessagesView({ targetAgent }: { targetAgent?: Address }) {
  const { session, agentAddress, profile } = useSession();
  // WHO IS SENDING. In a workspace-scoped Messages (`/org/<sa>/messages`) it is the ORG, and an org has
  // no session — so the org→person stewardship delegation travels with every call and the agent
  // re-verifies it. Absent stewardship on an org workspace is a real refusal, not a fallback to
  // sending as the person: that would put the person's name on the organization's mail.
  const { agents } = useManagedAgents(session?.token ?? null);
  const managed = targetAgent ? agents.find((a) => a.agent.toLowerCase() === targetAgent.toLowerCase()) : undefined;
  const sendingAs = (targetAgent ?? agentAddress ?? undefined) as Address | undefined;
  const stewardship = targetAgent ? managed?.stewardshipDelegation : undefined;
  const { view, refresh, loadThread, post, send, wireRequired, setWireRequired, busy, error, setError } = useInboxView(session, targetAgent, sendingAs, stewardship);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AgentSearchHit[] | null>(null);
  const [recipient, setRecipient] = useState<AgentSearchHit | null>(null);
  const [composeBody, setComposeBody] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [mobileThread, setMobileThread] = useState(false);
  const [railFilter, setRailFilter] = useState('');

  // spec 328 UX v2 — assistant config (toggle + SKILL.md playbook) lives on Manage → Agent
  // (`/agent`, AgentTab); this view keeps only the in-context delivery nudge via the shared hook.
  const delivery = useMessagingDelivery(targetAgent);

  useEffect(() => {
    const to = new URLSearchParams(window.location.search).get('to')?.trim().toLowerCase();
    if (!to) return;
    let cancelled = false;
    // An address is the identity. A relying app already resolved the name; do not search again.
    if (/^0x[0-9a-f]{40}$/.test(to)) {
      setRecipient({
        name: to,
        label: to,
        smartAgent: to,
        displayName: null,
        description: null,
        skills: null,
        registryStatus: null,
        facets: [],
      });
      setComposeOpen(true);
      setWireRequired(
        new MessagingWireRequiredError('wire_absent', to as Address, [], undefined, 'approve this contact'),
      );
      return;
    }
    void searchAgentsKb(to).then((found) => {
      if (cancelled || found.length === 0) return;
      const hit = found.find((h) => h.label.toLowerCase() === to) ?? found[0]!;
      setRecipient(hit);
      setComposeOpen(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [setWireRequired]);

  const conversations = useMemo(
    () => [...(view?.conversations ?? [])].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)),
    [view],
  );
  const activeId = open ?? conversations[0]?.conversationId ?? null;

  // VL-W4 — the list/poll is metadata-only; lazily fetch the OPEN thread's bodies. The guard fires once
  // per opened thread (and again when a poll delivers a new message into it, since that messageId won't be
  // in `bodies`), and settles as soon as the bodies land — no render loop.
  const threadNeedsBodies =
    !!activeId && !!view &&
    view.items.some((i) => i.conversationId === activeId && i.folder !== 'trash' && !(i.messageId in view.bodies));
  useEffect(() => {
    if (threadNeedsBodies && activeId) void loadThread(activeId);
  }, [threadNeedsBodies, activeId, loadThread]);

  const thread = useMemo(() => {
    if (!view || !activeId) return [];
    return view.items
      .filter((i) => i.conversationId === activeId && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, activeId]);

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

  const previewFor = useCallback(
    (conversationId: string): string => {
      if (!view) return '';
      const last = [...view.items]
        .filter((i) => i.conversationId === conversationId && i.folder !== 'trash')
        .sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt))[0];
      if (!last) return '';
      // VL-W4 — bodies are lazy: use the body preview when it's already loaded (open threads), else fall
      // back to the envelope subject (metadata, always present) so the rail never blocks on a body read.
      return messagePreview(view.bodies[last.messageId]) || view.envelopeMeta[last.messageId]?.subject || 'New message';
    },
    [view],
  );

  const filteredConversations = useMemo(() => {
    const q = railFilter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const title = titleFor(c.conversationId).toLowerCase();
      const preview = previewFor(c.conversationId).toLowerCase();
      return title.includes(q) || preview.includes(q);
    });
  }, [conversations, railFilter, titleFor, previewFor]);

  useEffect(() => {
    if (!view || !activeId) return;
    const unread = view.items.filter((i) => i.conversationId === activeId && i.unread && i.folder !== 'sent');
    for (const i of unread) void post({ action: 'read', messageId: i.messageId }, `read:${i.messageId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, view?.summary.unreadTotal]);

  const activeDescriptor = activeId ? view?.descriptors[activeId] : undefined;
  // The conversation SUBJECT (descriptor title, set from the first message's subject; replies inherit it).
  // titleFor prefers the counterparty name, so surface the subject as the thread-header subtitle.
  const activeSubject = activeDescriptor?.title && activeId && activeDescriptor.title !== titleFor(activeId) ? activeDescriptor.title : null;
  const canReply = !!activeDescriptor && activeDescriptor.participants.length === 2;
  const activeCase = activeId ? caseFor(activeId) : null;
  const activePending = !!activeCase && PENDING_STATES.includes(activeCase.state);
  const selfAvatarKey = agentAddress ? personAvatarKey(agentAddress) : null;
  const selfAvatar = useAvatar(selfAvatarKey);

  const sendReply = async (body: string) => {
    if (!activeId || !body.trim()) return;
    await send({ conversationId: activeId, bodyText: body }, `reply:${activeId}`);
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

  const sendNew = async (body: string) => {
    if (!recipient || !body.trim()) return;
    const subject = composeSubject.trim();
    const addr = recipient.smartAgent.trim().toLowerCase();
    const to = /^0x[0-9a-f]{40}$/.test(addr)
      ? { recipient: addr as Address }
      : { recipientName: recipient.name };
    const ok = await send({ ...to, bodyText: body, ...(subject ? { subject } : {}) }, 'compose');
    if (ok) {
      setComposeOpen(false);
      setRecipient(null);
      setComposeBody('');
      setComposeSubject('');
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
        const sign = await signHashFor(session.via.toLowerCase() as Via, agentAddress as Address, { token: session.token });
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
      <SectionShell title="Messages" wide>
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
          className={a.style === 'destructive' ? 'btn-danger' : 'btn-primary'}
          style={{ width: 'auto' }}
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

  const selectConv = (id: string) => {
    setOpen(id);
    setMobileThread(true);
  };

  return (
    <SectionShell
      title="Messages"
      description="Direct messages and requests in one place"
      actions={!targetAgent ? (
        <span style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
          {/* spec 334 §5 — posting a request is a first-class Home action; the
              goal-first composer lives on My Work. */}
          <a
            href="/work"
            className="ghost"
            title="New request — describe a goal for a person or organization (My Work)"
            style={{ textDecoration: 'none', fontSize: '0.8rem' }}
          >
            New request
          </a>
          <a
            href="/agent"
            className="ghost"
            aria-label="Agent settings — message bot & playbook"
            title="Agent settings (Manage → Agent) — message bot & playbook"
            style={{ textDecoration: 'none' }}
          >
            🤖
          </a>
        </span>
      ) : undefined}
    >
      <ApproveMessaging
        need={wireRequired}
        person={sendingAs ?? null}
        stewardship={stewardship}
        session={session}
        credential={profile?.credential}
        onApproved={() => {
          setWireRequired(null);
          const ret = new URLSearchParams(window.location.search).get('return');
          if (ret && isAllowedRelyingOrigin(ret)) window.location.assign(ret);
        }}
        onError={setError}
      />
      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {pendingCases.length > 0 && (
        <div className="chat-attention">
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.5rem' }}>Needs attention · {pendingCases.length}</div>
          {pendingCases.map((c) => {
            const card = view?.cards[c.id];
            return (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', padding: '0.6rem 0.8rem', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: '0.4rem' }}>
                <div>
                  <b>{card?.title ?? c.subject}</b>
                  <div style={{ fontSize: '0.82rem', opacity: 0.75 }}>
                    {card?.summary ?? `${c.kind} · from ${agentLabel(c.requester, view?.names)}`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  {caseActions(c)}
                  {convForCase(c) && (
                    <button type="button" className="ghost" onClick={() => selectConv(convForCase(c)!)}>Open thread</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {delivery.enabled === false && (
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', borderRadius: 10, padding: '0.5rem 0.8rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.83rem', color: 'var(--color-sage-700)' }}>
            <b>Secure your message storage.</b> Store message contents encrypted in your personal vault — also
            manageable under <a href="/agent">Manage → Agent</a>.
          </span>
          <button type="button" className="btn" disabled={delivery.busy} onClick={() => void delivery.enable()}>
            {delivery.busy ? 'Signing…' : 'Enable vault storage'}
          </button>
          {delivery.error && <span style={{ fontSize: '0.78rem', color: 'var(--color-danger)' }}>{delivery.error}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <AvatarUpload
          name="You"
          imageUrl={selfAvatar}
          size={36}
          editable={!!agentAddress}
          onUpload={(url) => { if (agentAddress) setPersonAvatar(agentAddress, url); }}
        />
        <input
          placeholder="Search people…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setComposeOpen(true); void runSearch(); } }}
          style={{ flex: 1, minWidth: 180, padding: '0.5rem 0.85rem', border: '1px solid var(--color-border)', borderRadius: 999 }}
        />
        <button type="button" className="btn" disabled={!query.trim()} onClick={() => { setComposeOpen(true); void runSearch(); }}>Search</button>
        <button type="button" className="ghost" onClick={() => { setComposeOpen((v) => !v); setHits(null); }}>
          {composeOpen ? 'Close' : 'New message'}
        </button>
      </div>

      {composeOpen && (
        <div style={{ border: '1px solid var(--color-amber-400)', background: 'var(--color-amber-50)', borderRadius: 12, padding: '1rem', marginBottom: '1rem' }}>
          {!recipient ? (
            <>
              <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>To: pick a person from search results</div>
              {hits === null ? (
                <div style={{ fontSize: '0.82rem', opacity: 0.65 }}>Type above and hit Search.</div>
              ) : hits.length === 0 ? (
                <div style={{ fontSize: '0.82rem', opacity: 0.65 }}>No matches for “{query.trim()}”.</div>
              ) : (
                hits.map((h) => (
                  <button
                    key={h.smartAgent}
                    type="button"
                    onClick={() => setRecipient(h)}
                    style={{ display: 'flex', gap: '0.65rem', alignItems: 'center', justifyContent: 'flex-start', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--color-text-body)', fontWeight: 400, cursor: 'pointer', padding: '0.5rem 0', borderBottom: '1px solid var(--color-border)' }}
                  >
                    <AvatarUpload name={h.displayName ?? h.name} size={40} />
                    <div>
                      <b>{h.displayName ?? h.name}</b>
                      {h.displayName && <div style={{ fontSize: '0.76rem', opacity: 0.65 }}>{h.name}</div>}
                    </div>
                  </button>
                ))
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <AvatarUpload name={recipient.displayName ?? recipient.name} size={32} />
                <span>To: <b>{recipient.displayName ?? recipient.name}</b></span>
                <button type="button" className="ghost" style={{ fontSize: '0.75rem', minHeight: 0, padding: '0.15rem 0.5rem' }} onClick={() => setRecipient(null)}>change</button>
              </div>
              <input
                placeholder="Subject (optional)"
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                style={{ width: '100%', marginBottom: '0.5rem', padding: '0.5rem 0.85rem', border: '1px solid var(--color-border)', borderRadius: 8 }}
              />
              <MessageComposer
                value={composeBody}
                onChange={setComposeBody}
                onSend={sendNew}
                busy={busy === 'compose'}
                rows={3}
                placeholder="Write your message…"
              />
            </>
          )}
        </div>
      )}

      {conversations.length === 0 ? (
        <p style={{ opacity: 0.7 }}>No conversations yet — search a name and send the first message.</p>
      ) : (
        <div className={`chat-shell${mobileThread && activeId ? ' chat-shell--thread-open' : ''}`}>
          <div className="chat-rail">
            <div className="chat-rail-search">
              <input
                placeholder="Filter conversations…"
                value={railFilter}
                onChange={(e) => setRailFilter(e.target.value)}
                aria-label="Filter conversations"
              />
            </div>
            <div className="chat-rail-list">
              {filteredConversations.length === 0 && railFilter.trim() ? (
                <p className="chat-rail-empty">No matches for &ldquo;{railFilter.trim()}&rdquo;</p>
              ) : null}
              {filteredConversations.map((c) => {
                const cCase = caseFor(c.conversationId);
                const isPending = !!cCase && PENDING_STATES.includes(cCase.state);
                const title = titleFor(c.conversationId);
                return (
                  <button
                    key={c.conversationId}
                    type="button"
                    className={`chat-rail-item${c.conversationId === activeId ? ' chat-rail-item--active' : ''}`}
                    onClick={() => selectConv(c.conversationId)}
                  >
                    {view && <ConvAvatar conversationId={c.conversationId} title={title} view={view} />}
                    <div className="chat-rail-item__meta">
                      <div className={`chat-rail-item__title${c.unread > 0 ? ' chat-rail-item__title--unread' : ''}`}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                        {c.unread > 0 && <span className="chat-unread-badge">{c.unread}</span>}
                      </div>
                      <div className="chat-rail-item__preview">
                        {isPending && <span style={{ color: 'var(--color-amber-700)', fontWeight: 600 }}>● review · </span>}
                        {previewFor(c.conversationId)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="chat-thread">
            {activeId ? (
              <>
                <div className="chat-thread-header">
                  <button
                    type="button"
                    className="chat-slide-back chat-thread-back"
                    onClick={() => setMobileThread(false)}
                    aria-label="Back to conversations"
                  >
                    ←
                  </button>
                  {view && <ConvAvatar conversationId={activeId} title={titleFor(activeId)} view={view} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="chat-thread-header__title">{titleFor(activeId)}</div>
                    {activeSubject && (
                      <div style={{ fontSize: '0.78rem', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeSubject}</div>
                    )}
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                      {(view?.descriptors[activeId]?.contextRefs ?? []).map((r) => <ContextChip key={`${r.kind}:${r.id}`} r={r} names={view?.names} />)}
                    </div>
                  </div>
                </div>

                {activeCase && activePending && (
                  <div className="chat-attention" style={{ margin: '0.75rem 1rem 0' }}>
                    <b>{view?.cards[activeCase.id]?.title ?? activeCase.subject}</b>
                    <div style={{ fontSize: '0.82rem', opacity: 0.75, margin: '0.2rem 0 0.5rem' }}>
                      {view?.cards[activeCase.id]?.summary ?? `${activeCase.kind} · from ${agentLabel(activeCase.requester, view?.names)}`}
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>{caseActions(activeCase)}</div>
                  </div>
                )}

                <div className="chat-thread-body">
                  {thread.map((i, idx) => {
                    const meta = view?.envelopeMeta[i.messageId];
                    const mine = i.folder === 'sent';
                    const prev = thread[idx - 1];
                    const next = thread[idx + 1];
                    const firstOfGroup = !prev || (prev.folder === 'sent') !== mine;
                    const lastOfGroup = !next || (next.folder === 'sent') !== mine;
                    // spec 328 — acting-agent provenance chip: theirs-side assistant replies show
                    // the author + "agent" chip; own-side assistant copies get a small caption.
                    const agentAuthored = !!meta?.actor;
                    return (
                      <div key={i.messageId}>
                        {agentAuthored && mine && firstOfGroup && (
                          <div style={{ textAlign: 'right', fontSize: '0.68rem', opacity: 0.6, margin: '0.15rem 0.5rem 0.1rem 0' }}>
                            🤖 sent by your assistant
                          </div>
                        )}
                        <MessageBubble
                          mine={mine}
                          body={view?.bodies[i.messageId]}
                          time={new Date(i.lastEventAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          verified={!!meta?.signatureSigner}
                          {...(agentAuthored && !mine
                            ? { showAuthor: true, authorName: meta ? agentLabel(meta.from, view?.names) : 'agent', authorBadge: 'agent' }
                            : {})}
                          firstOfGroup={firstOfGroup}
                          lastOfGroup={lastOfGroup}
                        />
                      </div>
                    );
                  })}
                </div>

                {canReply ? (
                  <MessageComposer value={draft} onChange={setDraft} onSend={sendReply} busy={busy === `reply:${activeId}`} rows={3} />
                ) : (
                  <div style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', opacity: 0.6, borderTop: '1px solid var(--color-border)' }}>
                    {activeCase ? 'Respond with the request actions above.' : 'Replies open once the conversation has a two-party descriptor.'}
                  </div>
                )}
              </>
            ) : (
              <p style={{ opacity: 0.7, margin: 'auto', padding: '2rem' }}>Select a conversation.</p>
            )}
          </div>
        </div>
      )}

      {view && Object.keys(view.mandates).length > 0 && (
        <details style={{ marginTop: '1.25rem' }}>
          <summary style={{ fontSize: '0.85rem', cursor: 'pointer' }}>Issued mandates ({Object.keys(view.mandates).length})</summary>
          {Object.entries(view.mandates).map(([intId, m]) => {
            const c = view.cases.find((x) => x.id === intId);
            return (
              <div key={m.mandateId} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--color-border)', fontSize: '0.82rem' }}>
                <b>{c?.subject ?? intId}</b>
                <div style={{ opacity: 0.7 }}>
                  {m.allowedActions.join(', ')} · {m.resourceScope.resource}
                  {' · delegation '}<code>{m.delegationHash.slice(0, 10)}…</code>
                </div>
              </div>
            );
          })}
        </details>
      )}

    </SectionShell>
  );
}
