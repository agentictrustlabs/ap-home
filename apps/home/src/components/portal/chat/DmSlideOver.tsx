'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { agentAddressOf, directMessageKey } from '@agenticprimitives/fabric/messaging';
import { useInboxView, agentLabel } from '../../../home/use-inbox';
import { useSession } from '../../../context/session';
import { ApproveMessaging } from '../ApproveMessaging';
import { searchAgentsKb } from '../../../lib/agent-search';
import { AvatarUpload } from './AvatarUpload';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { personAvatarKey } from '../../../lib/avatar-store';
import { useAvatar } from './use-avatar';
import { messagePreview } from './message-content';

type Resolution = 'resolving' | 'resolved' | 'not-found';

export function DmSlideOver({
  session,
  recipientName,
  recipientLabel,
  recipientSubject,
  channelContext,
  onClose,
}: {
  session: { token: string };
  recipientName: string;
  recipientLabel: string;
  recipientSubject?: string;
  /** When opened from a channel, show breadcrumb so user stays oriented. */
  channelContext?: { channelTitle: string };
  onClose: () => void;
}) {
  const { agentAddress, profile } = useSession();
  const { view, refresh, loadThread, send: sendMessageViaAgent, approved, wireRequired, error, busy } = useInboxView(session, undefined, agentAddress ?? undefined);
  const [dmError, setDmError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // The counterparty's ADDRESS — the DM is the pair, so this is what both the bucket lookup and the send key on.
  const [resolvedAddr, setResolvedAddr] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>('resolving');
  const historyPushed = useRef(false);

  // The listing subject may arrive as CAIP-10 (`eip155:…:0x…`) or a bare address — the send + bucket key want the address.
  const subjectAddr = recipientSubject ? agentAddressOf(recipientSubject) || null : null;
  const avatarKey = recipientSubject ? personAvatarKey(recipientSubject) : null;
  const imageUrl = useAvatar(avatarKey);

  const resolveRecipient = useCallback(async () => {
    setResolution('resolving');
    setResolvedAddr(null);
    try {
      const hits = await searchAgentsKb(recipientLabel);
      const hit = hits.find((h) => h.label.toLowerCase() === recipientLabel.toLowerCase()) ?? hits[0];
      if (hit) {
        setResolvedAddr(hit.smartAgent.toLowerCase());
        setResolution('resolved');
      } else {
        setResolution('not-found');
      }
    } catch {
      setResolution('not-found');
    }
  }, [recipientLabel]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setResolution('resolving');
      setResolvedAddr(null);
      try {
        const hits = await searchAgentsKb(recipientLabel);
        if (cancelled) return;
        const hit = hits.find((h) => h.label.toLowerCase() === recipientLabel.toLowerCase()) ?? hits[0];
        if (hit) {
          setResolvedAddr(hit.smartAgent.toLowerCase());
          setResolution('resolved');
        } else {
          setResolution('not-found');
        }
      } catch {
        if (!cancelled) setResolution('not-found');
      }
    })();
    const fallback = window.setTimeout(() => {
      setResolution((prev) => (prev === 'resolving' ? 'not-found' : prev));
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
    };
  }, [recipientLabel]);

  const close = useCallback(() => {
    if (historyPushed.current) {
      historyPushed.current = false;
      history.back();
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    history.pushState({ chatDm: true }, '');
    historyPushed.current = true;
    const onPop = () => {
      historyPushed.current = false;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, close]);

  // The DM bucket with this person (spec 313 §2 amendment): keyed by their address when the KB
  // resolved one, else by the name the rail shows — every conversation with them folds into it.
  const dm = useMemo(() => {
    if (!view) return null;
    const known = subjectAddr ?? resolvedAddr;
    if (known) {
      const key = directMessageKey([known]);
      const hit = view.directMessages.find((d) => d.key === key);
      if (hit) return hit;
    }
    return view.directMessages.find((d) =>
      d.counterparties.length === 1 &&
      [recipientLabel, recipientName].some((n) => agentLabel(d.counterparties[0]!, view.names).toLowerCase() === n.toLowerCase()),
    ) ?? null;
  }, [view, recipientSubject, resolvedAddr, recipientLabel, recipientName]);
  const sendTo = (subjectAddr ?? resolvedAddr ?? dm?.counterparties[0] ?? null) as Address | null;

  const canSend = !!sendTo;

  // VL-W4 — bodies are lazy (metadata-first list); load the DM's bodies (one call per folded
  // conversation) when it resolves. Guards on missing bodies so it fires once + when a poll delivers a
  // new message, without looping.
  const needBodies = useMemo(() => {
    if (!dm || !view) return '';
    return dm.conversationIds.filter((cid) => view.items.some((i) => i.conversationId === cid && i.folder !== 'trash' && !(i.messageId in view.bodies))).join(',');
  }, [dm, view]);
  useEffect(() => {
    if (!needBodies) return;
    for (const cid of needBodies.split(',')) void loadThread(cid);
  }, [needBodies, loadThread]);

  const thread = useMemo(() => {
    if (!view || !dm) return [];
    const convs = new Set<string>(dm.conversationIds);
    return view.items
      .filter((i) => convs.has(i.conversationId) && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, dm]);

  // The agent derives the pair's conversation id from the recipient — no thread to pick.
  const send = useCallback(async (body: string) => {
    if (!sendTo) return;
    await sendMessageViaAgent({ recipient: sendTo, bodyText: body }, `dm:${sendTo}`);
    await refresh();
  }, [sendTo, sendMessageViaAgent, refresh]);

  const composerPlaceholder = useMemo(() => {
    if (sendTo) return `Message ${recipientName}…`;
    if (resolution === 'resolving') return `Finding ${recipientName}…`;
    return `Can't message until ${recipientName} is found`;
  }, [sendTo, resolution, recipientName]);

  return (
    <>
      <div className="chat-slide-scrim" onClick={close} />
      <div className="chat-slide-panel" role="dialog" aria-label={`Message ${recipientName}`}>
        <div className="chat-slide-header">
          <button type="button" className="chat-slide-back" onClick={close} aria-label="Back to channel">←</button>
          <AvatarUpload name={recipientName} imageUrl={imageUrl} size={40} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="chat-thread-header__title">{recipientName}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{recipientLabel}</div>
            {channelContext && (
              <div className="chat-dm-context">
                From <span className="chat-dm-context__channel"># {channelContext.channelTitle}</span>
              </div>
            )}
          </div>
        </div>

        {resolution === 'not-found' && !sendTo && (
          <div className="chat-dm-resolution-banner" role="status">
            <span>Couldn&apos;t find <b>{recipientName}</b> in the directory.</span>
            <div className="chat-dm-resolution-banner__actions">
              <button type="button" className="btn" onClick={() => void resolveRecipient()}>Try again</button>
              <a href="/messages" className="btn-ghost" style={{ fontSize: '0.82rem' }}>Search all people</a>
            </div>
          </div>
        )}

        {resolution === 'resolving' && !sendTo && (
          <div className="chat-dm-resolution-banner chat-dm-resolution-banner--pending" role="status">
            Finding {recipientName}…
          </div>
        )}

        {/* spec 341 §5.1b — the send needs the person's approval before their agent can carry it. */}
        <ApproveMessaging
          need={wireRequired}
          person={agentAddress ?? null}
          session={session}
          credential={profile?.credential}
          onApproved={() => { setDmError(null); void approved(); }}
          onError={setDmError}
        />
        {(dmError ?? error) && (
          <div className="chat-dm-resolution-banner" role="status" style={{ color: 'var(--color-danger)' }}>{dmError ?? error}</div>
        )}

        <div className="chat-thread-body">
          {thread.length === 0 && canSend && (
            <p style={{ textAlign: 'center', opacity: 0.6, margin: 'auto', fontSize: '0.85rem' }}>
              No messages yet — say hello to {recipientName}.
            </p>
          )}
          {thread.map((i, idx) => {
            const meta = view?.envelopeMeta[i.messageId];
            const mine = i.folder === 'sent';
            const prev = thread[idx - 1];
            const next = thread[idx + 1];
            const firstOfGroup = !prev || (prev.folder === 'sent') !== mine;
            const lastOfGroup = !next || (next.folder === 'sent') !== mine;
            return (
              <MessageBubble
                key={i.messageId}
                mine={mine}
                body={view?.bodies[i.messageId]}
                time={new Date(i.lastEventAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                verified={!!meta?.signatureSigner}
                firstOfGroup={firstOfGroup}
                lastOfGroup={lastOfGroup}
              />
            );
          })}
        </div>

        <MessageComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          busy={busy !== null}
          disabled={!canSend}
          rows={3}
          placeholder={composerPlaceholder}
        />
      </div>
    </>
  );
}

export { messagePreview };
