'use client';

import { MessageContent } from './message-content';

export function MessageBubble({
  mine,
  body,
  time,
  verified,
  authorName,
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
