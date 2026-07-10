'use client';

const IMG_RE = /!\[[^\]]*\]\((data:image\/[^)]+)\)/g;

/** Strip image markdown for conversation list previews. */
export function messagePreview(body: string | undefined): string {
  if (!body) return '';
  return body.replace(IMG_RE, '📷 Photo').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Build a message body with optional inline image (stored as markdown data-URL). */
export function buildMessageBody(text: string, imageDataUrl?: string | null): string {
  const parts: string[] = [];
  const t = text.trim();
  if (t) parts.push(t);
  if (imageDataUrl) parts.push(`![photo](${imageDataUrl})`);
  return parts.join('\n');
}

export function MessageContent({ body, fallback }: { body?: string | null; fallback?: string }) {
  if (!body) {
    return <em style={{ opacity: 0.7 }}>{fallback ?? 'content in vault…'}</em>;
  }

  const segments: { type: 'text' | 'img'; value: string }[] = [];
  let last = 0;
  for (const m of body.matchAll(IMG_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ type: 'text', value: body.slice(last, idx) });
    segments.push({ type: 'img', value: m[1]! });
    last = idx + m[0].length;
  }
  if (last < body.length) segments.push({ type: 'text', value: body.slice(last) });

  if (segments.length === 0) return <>{body}</>;

  return (
    <>
      {segments.map((s, i) =>
        s.type === 'img' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={s.value} alt="" className="chat-bubble__img" />
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </>
  );
}
