// The link-preview image (Open Graph / Twitter card) for every page of the Home: the brand shield, the brand name
// and its tagline on the warm ground, drawn by next/og at build time from the white-label config (ADR-0021).
import { ImageResponse } from 'next/og';
import { whitelabel } from '../src/whitelabel/config';

export const alt = `${whitelabel.brand.name} — ${whitelabel.brand.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  const { name, tagline } = whitelabel.brand;
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(160deg, #fffbeb 0%, #fef3c7 100%)', color: '#1c1917', fontFamily: 'sans-serif' }}>
        <svg width="140" height="161" viewBox="0 0 40 46" fill="none">
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="50%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#d97706" />
            </linearGradient>
          </defs>
          <path d="M20 1.5 3 8.2v13.4C3 32.4 11 39.8 20 44.5c9-4.7 17-12.1 17-22.9V8.2L20 1.5Z" fill="url(#g)" />
          <path d="M13.5 22.5 18 27l9-9" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <div style={{ fontSize: 84, fontWeight: 700, marginTop: 28, letterSpacing: -2 }}>{name}</div>
        <div style={{ fontSize: 36, color: '#78716c', marginTop: 12 }}>{tagline}</div>
        <div style={{ fontSize: 24, color: '#b45309', marginTop: 40 }}>a Home on the Agentic Primitives substrate</div>
      </div>
    ),
    size,
  );
}
