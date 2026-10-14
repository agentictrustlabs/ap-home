// The favicon Google shows beside a result: the brand shield (src/components/shared/BrandShield.tsx), drawn by
// next/og at build time. Same path, same three amber stops; the wordmark is white-label config and not in a mark.
// A deployment that wears its operator's mark (NEXT_PUBLIC_BRAND_MARK=globe) gets that mark here too, so the tab and
// the sign-in window's title bar match the screen beneath them.
import { ImageResponse } from 'next/og';
import { BRAND_MARK, GCID_MARK, GLOBE_BLUE, GlobeLines } from '../src/components/shared/BrandShield';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  if (BRAND_MARK === 'gcid') {
    return new ImageResponse(
      (
        <div style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={GCID_MARK} width={64} height={64} alt="" />
        </div>
      ),
      size,
    );
  }
  if (BRAND_MARK === 'globe') {
    return new ImageResponse(
      (
        <div style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
          {/* A heavier line than on the page: at 16px the page's weight is under a pixel. */}
          <svg width="64" height="64" viewBox="0 0 100 100" fill="none">
            {GlobeLines({ stroke: GLOBE_BLUE, strokeWidth: 8 })}
          </svg>
        </div>
      ),
      size,
    );
  }
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
