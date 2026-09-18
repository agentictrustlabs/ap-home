// The favicon Google shows beside a result: the brand shield (src/components/shared/BrandShield.tsx), drawn by
// next/og at build time. Same path, same three amber stops; the wordmark is white-label config and not in a mark.
import { ImageResponse } from 'next/og';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
        <svg width="52" height="60" viewBox="0 0 40 46" fill="none">
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
      </div>
    ),
    size,
  );
}
