'use client';
// Telegram-style avatar: a round image when one is set, else a deterministic-colored circle with the
// first letter (the fallback every chat app uses). Shared by channels + messages so identity looks the
// same everywhere. `imageUrl` is a self-contained data-URL / https URL (avatar-upload slice wires it in).
import type { CSSProperties } from 'react';

/** Deterministic hue per name — stable identity color across renders and surfaces. */
const hueOf = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function Avatar({
  name,
  imageUrl,
  size = 36,
  ring,
}: {
  name: string;
  imageUrl?: string | null;
  size?: number;
  /** Optional accent ring (e.g. to mark the active DM target). */
  ring?: string;
}) {
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: 'none',
    objectFit: 'cover',
    boxShadow: ring ? `0 0 0 2px #fff, 0 0 0 4px ${ring}` : undefined,
    userSelect: 'none',
  };
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- data/URL avatar, no Next image optimization needed
    return <img src={imageUrl} alt="" width={size} height={size} style={base} />;
  }
  return (
    <span
      aria-hidden
      style={{
        ...base,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.42),
        fontWeight: 600,
        color: '#fff',
        background: `linear-gradient(135deg, hsl(${hueOf(name)} 62% 52%), hsl(${(hueOf(name) + 24) % 360} 62% 44%))`,
      }}
    >
      {letter}
    </span>
  );
}
