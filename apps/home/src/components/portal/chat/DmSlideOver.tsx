'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInboxView, agentLabel } from '../../../home/use-inbox';
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
  const { view, refresh, loadThread, post, busy } = useInboxView(session);
  const [draft, setDraft] = useState('');
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>('resolving');
  const historyPushed = useRef(false);

  const avatarKey = recipientSubject ? personAvatarKey(recipientSubject) : null;
  const imageUrl = useAvatar(avatarKey);

  const resolveRecipient = useCallback(async () => {
    setResolution('resolving');
    setResolvedName(null);
    try {
      const hits = await searchAgentsKb(recipientLabel);
      const hit = hits.find((h) => h.label.toLowerCase() === recipientLabel.toLowerCase()) ?? hits[0];
      if (hit) {
        setResolvedName(hit.name);
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
      setResolvedName(null);
      try {
        const hits = await searchAgentsKb(recipientLabel);
        if (cancelled) return;
        const hit = hits.find((h) => h.label.toLowerCase() === recipientLabel.toLowerCase()) ?? hits[0];
        if (hit) {
          setResolvedName(hit.name);
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

  const conversationId = useMemo(() => {
    if (!view) return null;
    for (const c of view.conversations) {
      const title = view.descriptors[c.conversationId]?.participants.find((p) => {
        const a = p.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase();
        return a && view.names?.[a]?.toLowerCase() === recipientLabel.toLowerCase();
      });
      if (title) return c.conversationId;
      const d = view.descriptors[c.conversationId];
      const other = d?.participants.find((p) => agentLabel(p, view.names).toLowerCase() === recipientName.toLowerCase());
      if (other) return c.conversationId;
    }
    return null;
  }, [view, recipientLabel, recipientName]);

  const canSend = !!conversationId || resolution === 'resolved';

  // VL-W4 — bodies are lazy (metadata-first list); load this DM conversation's bodies when it resolves.
  // Guard on missing bodies so it fires once + when a poll delivers a new message, without looping.
  const dmNeedsBodies =
    !!conversationId && !!view &&
    view.items.some((i) => i.conversationId === conversationId && i.folder !== 'trash' && !(i.messageId in view.bodies));
  useEffect(() => {
    if (dmNeedsBodies && conversationId) void loadThread(conversationId);
  }, [dmNeedsBodies, conversationId, loadThread]);

  const thread = useMemo(() => {
    if (!view || !conversationId) return [];
    return view.items
      .filter((i) => i.conversationId === conversationId && i.folder !== 'trash')
      .sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  }, [view, conversationId]);

  const send = useCallback(async (body: string) => {
    if (conversationId) {
      await post({ action: 'reply', conversationId, bodyText: body }, `dm-reply:${conversationId}`);
    } else if (resolvedName) {
      await post({ action: 'send', toName: resolvedName, bodyText: body }, 'dm-send');
      await refresh();
    }
  }, [conversationId, resolvedName, post, refresh]);

  const composerPlaceholder = useMemo(() => {
    if (conversationId || resolution === 'resolved') return `Message ${recipientName}…`;
    if (resolution === 'resolving') return `Finding ${recipientName}…`;
    return `Can't message until ${recipientName} is found`;
  }, [conversationId, resolution, recipientName]);

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

        {resolution === 'not-found' && !conversationId && (
          <div className="chat-dm-resolution-banner" role="status">
            <span>Couldn&apos;t find <b>{recipientName}</b> in the directory.</span>
            <div className="chat-dm-resolution-banner__actions">
              <button type="button" className="btn" onClick={() => void resolveRecipient()}>Try again</button>
              <a href="/messages" className="btn-ghost" style={{ fontSize: '0.82rem' }}>Search all people</a>
            </div>
          </div>
        )}

        {resolution === 'resolving' && !conversationId && (
          <div className="chat-dm-resolution-banner chat-dm-resolution-banner--pending" role="status">
            Finding {recipientName}…
          </div>
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
          placeholder={composerPlaceholder}
        />
      </div>
    </>
  );
}

export { messagePreview };
