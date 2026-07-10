'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInboxView, agentLabel } from '../../../home/use-inbox';
import { searchAgentsKb } from '../../../lib/agent-search';
import { AvatarUpload } from './AvatarUpload';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { personAvatarKey } from '../../../lib/avatar-store';
import { useAvatar } from './use-avatar';
import { messagePreview } from './message-content';

export function DmSlideOver({
  session,
  recipientName,
  recipientLabel,
  recipientSubject,
  onClose,
}: {
  session: { token: string };
  recipientName: string;
  recipientLabel: string;
  recipientSubject?: string;
  onClose: () => void;
}) {
  const { view, refresh, post, busy } = useInboxView(session);
  const [draft, setDraft] = useState('');
  const [resolvedName, setResolvedName] = useState<string | null>(null);

  const avatarKey = recipientSubject ? personAvatarKey(recipientSubject) : null;
  const imageUrl = useAvatar(avatarKey);

  useEffect(() => {
    void searchAgentsKb(recipientLabel).then((hits) => {
      const hit = hits.find((h) => h.label.toLowerCase() === recipientLabel.toLowerCase()) ?? hits[0];
      if (hit) setResolvedName(hit.name);
    });
  }, [recipientLabel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  return (
    <>
      <div className="chat-slide-scrim" onClick={onClose} />
      <div className="chat-slide-panel" role="dialog" aria-label={`Message ${recipientName}`}>
        <div className="chat-slide-header">
          <button type="button" className="chat-slide-back" onClick={onClose} aria-label="Close">←</button>
          <AvatarUpload name={recipientName} imageUrl={imageUrl} size={40} />
          <div>
            <div className="chat-thread-header__title">{recipientName}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{recipientLabel}</div>
          </div>
        </div>

        <div className="chat-thread-body">
          {thread.length === 0 && (
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
          disabled={!resolvedName && !conversationId}
          placeholder={resolvedName || conversationId ? `Message ${recipientName}…` : 'Resolving recipient…'}
        />
      </div>
    </>
  );
}

export { messagePreview };
