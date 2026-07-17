'use client';

import { MessageContent } from './message-content';

export function MessageBubble({
  mine,
  body,
  time,
  verified,
  authorName,
  authorBadge,
  showAuthor,
  firstOfGroup,
  lastOfGroup,
  onAuthorClick,
}: {
  mine: boolean;
  body?: string | null;
  time: string;
  verified?: boolean;
  authorName?: string;
  /** Small chip next to the author name (spec 327: "agent" on assistant-authored posts). */
  authorBadge?: string;
  showAuthor?: boolean;
  firstOfGroup?: boolean;
  lastOfGroup?: boolean;
  onAuthorClick?: () => void;
}) {
  const bubbleClass = [
    'chat-bubble',
    mine ? 'chat-bubble--mine' : 'chat-bubble--theirs',
    mine && lastOfGroup ? 'chat-bubble--tail-mine' : '',
    !mine && lastOfGroup ? 'chat-bubble--tail-theirs' : '',
  ].filter(Boolean).join(' ');

  const wrapClass = [
    'chat-bubble-wrap',
    mine ? 'chat-bubble-wrap--mine' : 'chat-bubble-wrap--theirs',
    !firstOfGroup ? 'chat-bubble-wrap--grouped' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={wrapClass}>
      {showAuthor && authorName && !mine && firstOfGroup && (
        <button type="button" className="chat-bubble-author" onClick={onAuthorClick}>
          {authorName}
          {authorBadge && (
            <span
              style={{
                marginLeft: '0.35rem', padding: '0.05rem 0.35rem', borderRadius: '0.5rem',
                fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em',
                background: 'var(--color-accent-soft, rgba(180,120,0,0.12))', color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border, rgba(0,0,0,0.12))', verticalAlign: 'middle',
              }}
            >
              {authorBadge}
            </span>
          )}
        </button>
      )}
      <div className={bubbleClass}>
        <MessageContent body={body} />
        <span className="chat-bubble__time">
          {time}
          {verified ? ' ✓' : ''}
        </span>
      </div>
    </div>
  );
}
