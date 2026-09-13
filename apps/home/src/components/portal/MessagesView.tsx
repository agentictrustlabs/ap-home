'use client';
// Messages (spec 313 v2 + §2 amendment) — SLACK-STYLE DIRECT MESSAGES. The rail is bucketed by WHO
// (one row per counterparty, folding every conversation with them — `view.directMessages`), each row
// shows the last message ("You: …" when it was yours) and when, and "New message" is a To: typeahead
// with no subject line. Requests stay pinned above; a request's thread lives inside the DM with the
// party that raised it. Rich compose (emoji + images), amber design system.
import { BotIcon } from '../shared/Icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import type { InteractionCaseV1 } from '@agenticprimitives/fabric/interactions';
import { useSession } from '../../context/session';
import { askCommand } from '../../home/ask-command';
import { SectionShell } from '../../components/portal/SectionShell';
import { issueMandateForCase } from '../../home/mandate';
import { signHashFor, type Via } from '../../home/onboarding';
import { useInboxView, shortId, agentLabel } from '../../home/use-inbox';
import { directMessageKey, type DirectMessageSummaryV1 } from '@agenticprimitives/fabric/messaging';
import { searchAgentsKb } from '../../lib/agent-search';
import { personAvatarKey, setPersonAvatar } from '../../lib/avatar-store';
import { AvatarUpload } from './chat/AvatarUpload';
import { useMessagingDelivery } from './agent/AgentTab';
import { MessageBubble } from './chat/MessageBubble';
import { MessageComposer } from './chat/MessageComposer';
import { messagePreview } from './chat/message-content';
import { useAvatar } from './chat/use-avatar';
import { useManagedAgents } from './ManagedAgents';
import { railDate } from './chat/rail-date';
import { RecipientPicker } from './chat/RecipientPicker';
import type { PickedRecipient } from '../../lib/recipient-directory';
import { ApproveMessaging } from './ApproveMessaging';
import { MessagingWireRequiredError } from '../../lib/messaging-send';
import { isAllowedRelyingOrigin } from '../../lib/oidc-clients';
import { ShareWayChip, ContinuePaymentChip } from './chat/ActionChips';
import { AttentionBar } from './AttentionBar';
import { useTodayReads } from '../../home/use-today-inputs';
import { useMyWork } from './work/useWork';
import type { AttentionInputs } from '../../home/attention';


const PENDING_STATES = ['submitted', 'triaged'];

function ContextChip({ r, names }: { r: { kind: string; id: string; label?: string }; names?: Record<string, string> }) {
  // Spec 364 — a message that CARRIES a decision renders it here, where it was read. A pointer, never
  // authority: sharing still signs a grant, and finishing a payment still takes a mandate.
  if (r.kind === 'resolution-request') return <ShareWayChip refId={r.id} {...(r.label ? { label: r.label } : {})} />;
  if (r.kind === 'payment-continue') return <ContinuePaymentChip refId={r.id} {...(r.label ? { label: r.label } : {})} {...(names ? { names } : {})} />;
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
  if (r.kind === 'app-link' && /^https:\/\//.test(r.id)) {
    // A relying app's own page — where an invitation into one of its workspaces is picked up. The sender's
    // agent put the link in the message; the Home shows it as what it is, a door out to that app.
    return (
      <a href={r.id} target="_blank" rel="noopener noreferrer" className="badge"
        style={{ border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)', textDecoration: 'none', fontWeight: 600 }}
        title={r.id}>
        {r.label ?? 'Open in the app'} →
      </a>
    );
  }
  if (r.kind === 'contact' && /^0x[0-9a-fA-F]{40}$/.test(r.id)) {
    // Spec 401 — "I've added you to my contacts": the chip adds them BACK (mutual), through the Ask as the person's
    // own act — their mandate, their grant. The sender's address is the chip's id; the name is the thread's.
    const who = names?.[r.id.toLowerCase()];
    return (
      <button type="button" className="badge"
        style={{ border: '1px solid var(--color-sage-500)', background: 'var(--color-sage-50)', color: 'var(--color-sage-700)', fontWeight: 600, cursor: 'pointer' }}
        title={`Add ${who ?? r.id} to your contacts`}
        onClick={() => askCommand({ toolId: 'person.contact.invite', args: { contact: r.id.toLowerCase(), role: 'friend' }, message: `add ${who ?? r.id} as a contact (friend)` })}>
        {r.label ?? 'Add back'} →
      </button>
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

function DmAvatar({ addr, title, size = 48 }: { addr: string | null; title: string; size?: number }) {
  const imageUrl = useAvatar(addr ? personAvatarKey(addr) : null);
  return <AvatarUpload name={title} imageUrl={imageUrl} size={size} />;
}

const ADDR_RE = /^0x[0-9a-f]{40}$/;

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
  const { view, refresh, loadThread, loadPreviews, post, send, approved, wireRequired, setWireRequired, busy, error, setError } = useInboxView(session, targetAgent, sendingAs, stewardship);
  const me = (sendingAs ?? '').toLowerCase();

  // Spec 398 §5.5 — the attention model reads what Today reads (parked runs, schedule, Library) plus this inbox's cases.
  const reads = useTodayReads(session?.token, me || null, targetAgent ? 'other' : 'person');
  const { bundles } = useMyWork(session, targetAgent ? null : agentAddress);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [railFilter, setRailFilter] = useState('');

  // ── New message (Slack "To:" — scope picker: Names · Organizations · Workspaces) ─────────────────
  const [composing, setComposing] = useState(false);
  const [toQuery, setToQuery] = useState('');
  const [toRecipient, setToRecipient] = useState<PickedRecipient | null>(null);
  const [composeBody, setComposeBody] = useState('');

  // spec 328 UX v2 — assistant config (toggle + SKILL.md playbook) lives on Manage → Agent
  // (`/agent`, AgentTab); this view keeps only the in-context delivery nudge via the shared hook.
  const delivery = useMessagingDelivery(targetAgent);

  const dms = view?.directMessages ?? [];
  const dmByKey = useMemo(() => new Map(dms.map((d) => [d.key, d])), [dms]);

  const titleFor = useCallback(
    (dm: DirectMessageSummaryV1): string => {
      if (dm.counterparties.length === 1 && dm.counterparties[0] === me) return `${agentLabel(me, view?.names)} (you)`;
      return dm.counterparties.map((a) => agentLabel(a, view?.names)).join(', ');
    },
    [me, view],
  );

  const previewFor = useCallback(
    (dm: DirectMessageSummaryV1): string => {
      if (!view) return '';
      const text = messagePreview(view.bodies[dm.lastMessageId]) || view.envelopeMeta[dm.lastMessageId]?.subject || 'New message';
      return dm.lastFromOwner ? `You: ${text}` : text;
    },
    [view],
  );

  const openDm = useCallback((key: string) => {
    setComposing(false);
    setToRecipient(null);
    setOpenKey(key);
    setMobileThread(true);
  }, []);

  const startCompose = useCallback(() => {
    setComposing(true);
    setToRecipient(null);
    setToQuery('');
    setMobileThread(true);
  }, []);

  /** Pick someone to message: an existing DM opens; a new counterparty stays in compose until the first send. */
  const chooseRecipient = useCallback(
    (r: PickedRecipient) => {
      const key = directMessageKey([r.address]);
      if (dmByKey.has(key)) { openDm(key); return; }
      setToRecipient(r);
      setToQuery('');
    },
    [dmByKey, openDm],
  );

  // Deep link `?to=<name|0x…>` — a relying app or profile page asking to message someone.
  useEffect(() => {
    const to = new URLSearchParams(window.location.search).get('to')?.trim().toLowerCase();
    if (!to) return;
    let cancelled = false;
    // An address is the identity. A relying app already resolved the name; do not search again.
    if (ADDR_RE.test(to)) {
      setComposing(true);
      setToRecipient({ address: to, title: shortId(to), scope: 'names' });
      setWireRequired(new MessagingWireRequiredError('wire_absent', to as Address, [], undefined, 'approve this contact'));
      return;
    }
    void searchAgentsKb(to).then((found) => {
      if (cancelled || found.length === 0) return;
      const hit = found.find((h) => h.label.toLowerCase() === to) ?? found[0]!;
      if (!ADDR_RE.test(hit.smartAgent.toLowerCase())) return;
      setComposing(true);
      setToRecipient({ address: hit.smartAgent.toLowerCase(), title: hit.displayName ?? hit.name, subtitle: hit.name, name: hit.name, scope: 'names' });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [setWireRequired]);
  // Once the view lands, a deep-linked recipient we already talk to opens their DM instead.
  useEffect(() => {
    if (!composing || !toRecipient) return;
    const key = directMessageKey([toRecipient.address]);
    if (dmByKey.has(key)) openDm(key);
  }, [composing, toRecipient, dmByKey, openDm]);

  // People you already message — the picker ranks them first under Names, like Slack's recents.
  const recents = useMemo(
    () => dms.filter((d) => d.counterparties.length === 1 && d.counterparties[0] !== me).map((dm) => ({ address: dm.counterparties[0]!, title: titleFor(dm) })),
    [dms, me, titleFor],
  );

  const activeKey = composing ? null : (openKey && dmByKey.has(openKey) ? openKey : dms[0]?.key ?? null);
  const activeDm = activeKey ? dmByKey.get(activeKey) ?? null : null;

  // Rail previews — fetch the LAST message body per bucket, once per new last-message id.
  const previewsAsked = useRef(new Set<string>());
  useEffect(() => {
    if (!view) return;
    const want = dms.map((d) => d.lastMessageId).filter((id) => !(id in view.bodies) && !previewsAsked.current.has(id));
    if (want.length === 0) return;
    for (const id of want) previewsAsked.current.add(id);
    void loadPreviews(want);
  }, [view, dms, loadPreviews]);

  // VL-W4 — the list/poll is metadata-only; lazily fetch the OPEN DM's bodies, one conversation at a
  // time (a bucket may fold several). Fires once per opened DM and again when a poll delivers a new
  // message into it; settles as soon as the bodies land — no render loop.
  const threadConvsNeedingBodies = useMemo(() => {
    if (!activeDm || !view) return [] as string[];
    return activeDm.conversationIds.filter((cid) =>
      view.items.some((i) => i.conversationId === cid && i.folder !== 'trash' && !(i.messageId in view.bodies)),
    );
  }, [activeDm, view]);
  const threadNeedKey = threadConvsNeedingBodies.join(',');
  useEffect(() => {
    if (!threadNeedKey) return;
    for (const cid of threadNeedKey.split(',')) void loadThread(cid);
  }, [threadNeedKey, loadThread]);

  const thread = useMemo(() => {
    if (!view || !activeDm) return [];
    const convs = new Set<string>(activeDm.conversationIds);
    return view.items
      .filter((i) => convs.has(i.conversationId) && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, activeDm]);

  // Slack opens a DM at its NEWEST message. Scroll the thread to the bottom when it opens, and again
  // when a message lands (a body arriving for the last item counts — that is when it gets tall).
  const threadBodyRef = useRef<HTMLDivElement>(null);
  const lastId = thread[thread.length - 1]?.messageId;
  const lastBodyLoaded = !!lastId && !!view?.bodies[lastId];
  useEffect(() => {
    const el = threadBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeKey, thread.length, lastBodyLoaded]);

  const caseFor = useCallback(
    (dm: DirectMessageSummaryV1): InteractionCaseV1 | null => {
      if (!view) return null;
      const convs = new Set<string>(dm.conversationIds);
      const ids = new Set(view.items.filter((i) => convs.has(i.conversationId)).map((i) => i.interactionId).filter(Boolean));
      return view.cases.find((c) => ids.has(c.id)) ?? null;
    },
    [view],
  );
  const dmForCase = useCallback(
    (c: InteractionCaseV1): string | null => {
      const cid = view?.items.find((i) => i.interactionId === c.id)?.conversationId;
      return cid ? dms.find((d) => d.conversationIds.includes(cid))?.key ?? null : null;
    },
    [view, dms],
  );

  const attentionInputs = useMemo<AttentionInputs | null>(() => {
    if (!view || reads.parked === null) return null;
    return {
      now: Date.now(), parked: reads.parked, bundles: targetAgent ? [] : bundles, artifacts: reads.artifacts, triggers: reads.triggers, vocabulary: reads.vocabulary,
      me, cases: view.cases.map((c) => ({ id: c.id, kind: c.kind, subject: c.subject, state: c.state, requester: String(c.requester), responder: String(c.responder), updatedAt: c.updatedAt, ...(view.cards[c.id]?.title ? { title: view.cards[c.id]!.title } : {}), ...(view.cards[c.id]?.summary ? { summary: view.cards[c.id]!.summary } : {}) })),
      dms: dms.map((d) => ({ key: d.key, title: titleFor(d), unread: d.unread, lastEventAt: d.lastEventAt, preview: previewFor(d) })),
    };
  }, [view, reads.parked, reads.artifacts, reads.triggers, reads.vocabulary, bundles, me, dms, titleFor, previewFor, targetAgent]);

  const filteredDms = useMemo(() => {
    const q = railFilter.trim().toLowerCase();
    if (!q) return dms;
    return dms.filter((d) => titleFor(d).toLowerCase().includes(q) || previewFor(d).toLowerCase().includes(q));
  }, [dms, railFilter, titleFor, previewFor]);

  useEffect(() => {
    if (!view || !activeDm) return;
    const convs = new Set<string>(activeDm.conversationIds);
    const unread = view.items.filter((i) => convs.has(i.conversationId) && i.unread && i.folder !== 'sent');
    for (const i of unread) void post({ action: 'read', messageId: i.messageId }, `read:${i.messageId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, view?.summary.unreadTotal]);

  const activeCase = activeDm ? caseFor(activeDm) : null;
  const activePending = !!activeCase && PENDING_STATES.includes(activeCase.state);
  // Replies are two-party: the DM's one counterparty (or yourself). The agent derives the pair's
  // conversation id, so a reply never needs to pick which of the folded conversations to continue.
  const replyTo = activeDm && activeDm.counterparties.length === 1 ? (activeDm.counterparties[0] as Address) : null;
  const selfAvatarKey = agentAddress ? personAvatarKey(agentAddress) : null;
  const selfAvatar = useAvatar(selfAvatarKey);

  const sendReply = async (body: string) => {
    if (!replyTo || !body.trim()) return;
    await send({ recipient: replyTo, bodyText: body }, `reply:${activeKey}`);
  };

  // Always by ADDRESS — the SA is the identity (ADR-0010); a nameless org member has nothing else.
  const sendNew = async (body: string) => {
    if (!toRecipient || !body.trim()) return;
    const ok = await send({ recipient: toRecipient.address as Address, bodyText: body }, 'compose');
    if (ok) {
      setComposeBody('');
      await refresh();
      openDm(directMessageKey([toRecipient.address]));
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

  const recipientTitle = toRecipient?.title ?? '';

  return (
    // No page title: the rail already says "Direct messages" and the thread already names who you are
    // talking to. A "Messages" heading above them repeated that, more faintly, and pushed the content
    // down. The two page actions moved into the rail head, beside the compose button they belong with.
    <SectionShell>
      <ApproveMessaging
        need={wireRequired}
        person={sendingAs ?? null}
        stewardship={stewardship}
        session={session}
        credential={profile?.credential}
        onApproved={() => {
          // Finish the send the approval was for, then show it: the recipient becomes a DM bucket.
          void approved().then((ok) => {
            if (ok && toRecipient) openDm(directMessageKey([toRecipient.address]));
          });
          const ret = new URLSearchParams(window.location.search).get('return');
          if (ret && isAllowedRelyingOrigin(ret)) window.location.assign(ret);
        }}
        onError={setError}
      />
      {error && <p style={{ color: 'var(--color-danger)' }}>{error}</p>}

      {/* Spec 398 §5.5 — ATTENTION, NOT NOTIFICATIONS: six filters, one card per object, one action set each. */}
      {attentionInputs && me && (
        <AttentionBar
          inputs={attentionInputs} token={session.token} addressee={me as Address} onCanceled={reads.dropRun}
          renderCaseActions={(id) => { const c = view?.cases.find((x) => x.id === id); return c ? caseActions(c) : null; }}
          onOpenDm={openDm}
          onOpenCase={(id) => { const c = view?.cases.find((x) => x.id === id); const key = c ? dmForCase(c) : null; if (key) openDm(key); }}
        />
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

      <div className={`chat-shell${mobileThread && (activeKey || composing) ? ' chat-shell--thread-open' : ''}`}>
        <div className="chat-rail">
          {/* One header block: the title, its actions, and the filter that acts on the list below it.
              The filter used to sit in a bordered band of its own, which gave a search box the same
              visual weight as the section it searches. */}
          <div className="chat-rail-head">
            <AvatarUpload
              name="You"
              imageUrl={selfAvatar}
              size={26}
              editable={!!agentAddress}
              onUpload={(url) => { if (agentAddress) setPersonAvatar(agentAddress, url); }}
            />
            <span className="chat-rail-head__title">Messages</span>
            {!targetAgent && (
              <>
                {/* spec 334 §5 — posting a request is a first-class Home action; the goal-first
                    composer lives on My Work. */}
                <a href="/agent" className="chat-rail-action" aria-label="Agent settings — message bot and playbook" title="Agent settings — how your agent replies for you"><BotIcon size={15} /></a>
              </>
            )}
            <button
              type="button"
              className={`chat-rail-compose${composing ? ' chat-rail-compose--active' : ''}`}
              onClick={startCompose}
              aria-label="New message"
              title="New message"
            >
              ✎
            </button>
          </div>
          <div className="chat-rail-search">
            <input
              placeholder="Find a DM…"
              value={railFilter}
              onChange={(e) => setRailFilter(e.target.value)}
              aria-label="Find a direct message"
            />
          </div>
          <div className="chat-rail-list">
            {dms.length === 0 && (
              <p className="chat-rail-empty">
                No direct messages yet.{' '}
                <button type="button" className="ghost" style={{ display: 'inline', padding: 0, minHeight: 0 }} onClick={startCompose}>Start one</button>
              </p>
            )}
            {filteredDms.length === 0 && dms.length > 0 && railFilter.trim() ? (
              <p className="chat-rail-empty">No matches for &ldquo;{railFilter.trim()}&rdquo;</p>
            ) : null}
            {filteredDms.map((dm) => {
              const title = titleFor(dm);
              const isPending = dm.hasPending || (() => { const c = caseFor(dm); return !!c && PENDING_STATES.includes(c.state); })();
              return (
                <button
                  key={dm.key}
                  type="button"
                  className={`chat-rail-item${dm.key === activeKey ? ' chat-rail-item--active' : ''}`}
                  onClick={() => openDm(dm.key)}
                >
                  <DmAvatar addr={dm.counterparties.length === 1 ? dm.counterparties[0]! : null} title={title} />
                  <div className="chat-rail-item__meta">
                    <div className={`chat-rail-item__title${dm.unread > 0 ? ' chat-rail-item__title--unread' : ''}`}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                      <span className="chat-rail-item__when">
                        {dm.unread > 0 && <span className="chat-unread-badge">{dm.unread}</span>}
                        <time dateTime={dm.lastEventAt}>{railDate(dm.lastEventAt)}</time>
                      </span>
                    </div>
                    <div className="chat-rail-item__preview">
                      {isPending && <span style={{ color: 'var(--color-amber-700)', fontWeight: 600 }}>● review · </span>}
                      {previewFor(dm)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="chat-thread">
          {composing ? (
            <>
              <div className="chat-thread-header">
                <button type="button" className="chat-slide-back chat-thread-back" onClick={() => { setComposing(false); setMobileThread(false); }} aria-label="Back to direct messages">←</button>
                <div className="chat-thread-header__title" style={{ flex: 1 }}>New message</div>
                <button type="button" className="ghost" onClick={() => { setComposing(false); setToRecipient(null); }} aria-label="Close new message" style={{ minHeight: 0, padding: '0.2rem 0.5rem' }}>✕</button>
              </div>
              {toRecipient ? (
                <div className="chat-compose-to">
                  <span className="chat-compose-to__label">To:</span>
                  <span className="chat-compose-to__chip">
                    <AvatarUpload name={recipientTitle} size={22} />
                    <b>{recipientTitle}</b>
                    {toRecipient.subtitle && toRecipient.subtitle !== recipientTitle && <span style={{ opacity: 0.65 }}>{toRecipient.subtitle}</span>}
                    {!toRecipient.name && toRecipient.scope !== 'names' && <span className="chat-compose-result__tag" title="No naming-service name — addressed by their agent address">unnamed</span>}
                    <button type="button" className="ghost" style={{ minHeight: 0, padding: '0 0.3rem', fontSize: '0.8rem' }} onClick={() => setToRecipient(null)} aria-label="Change recipient">✕</button>
                  </span>
                </div>
              ) : (
                <RecipientPicker
                  token={session.token}
                  query={toQuery}
                  onQuery={setToQuery}
                  onPick={chooseRecipient}
                  onCancel={() => { setComposing(false); setToRecipient(null); }}
                  recents={recents}
                  names={view?.names}
                />
              )}
              {toRecipient && (
                <div className="chat-thread-body">
                  <p style={{ textAlign: 'center', opacity: 0.6, margin: 'auto', fontSize: '0.85rem' }}>
                    This is the start of your direct message history with <b>{recipientTitle}</b>.
                  </p>
                </div>
              )}
              <MessageComposer
                value={composeBody}
                onChange={setComposeBody}
                onSend={sendNew}
                busy={busy === 'compose'}
                disabled={!toRecipient}
                rows={3}
                placeholder={toRecipient ? `Message ${recipientTitle}…` : 'Choose a recipient first'}
              />
            </>
          ) : activeDm ? (
            <>
              <div className="chat-thread-header">
                <button
                  type="button"
                  className="chat-slide-back chat-thread-back"
                  onClick={() => setMobileThread(false)}
                  aria-label="Back to direct messages"
                >
                  ←
                </button>
                <DmAvatar addr={activeDm.counterparties.length === 1 ? activeDm.counterparties[0]! : null} title={titleFor(activeDm)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="chat-thread-header__title">{titleFor(activeDm)}</div>
                  {activeDm.counterparties.length === 1 && (
                    <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{shortId(activeDm.counterparties[0]!)}</div>
                  )}
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                    {activeDm.contextRefs.map((r) => <ContextChip key={`${r.kind}:${r.id}`} r={r} names={view?.names} />)}
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

              <div className="chat-thread-body" ref={threadBodyRef}>
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
                          sent by your assistant
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

              {replyTo ? (
                <MessageComposer value={draft} onChange={setDraft} onSend={sendReply} busy={busy === `reply:${activeKey}`} rows={3} placeholder={`Message ${titleFor(activeDm)}…`} />
              ) : (
                <div style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', opacity: 0.6, borderTop: '1px solid var(--color-border)' }}>
                  {activeCase ? 'Respond with the request actions above.' : 'Replies are two-party — this thread has several participants.'}
                </div>
              )}
            </>
          ) : (
            <div style={{ margin: 'auto', padding: '2rem', textAlign: 'center', opacity: 0.7 }}>
              <p style={{ margin: '0 0 0.5rem' }}>Select a direct message, or start a new one.</p>
              <button type="button" className="btn" onClick={startCompose}>New message</button>
            </div>
          )}
        </div>
      </div>

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
