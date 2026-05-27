'use client';
import dynamic from 'next/dynamic';

// The Connect SPA is a browser app (WebAuthn, window.location-relative host
// awareness, in-page crypto). Mount it client-only (ssr: false) inside the
// `#root` element its CSS targets — no SSR, matching the old Vite entry.
const App = dynamic(() => import('../src/App').then((m) => m.App), { ssr: false });

export default function Page() {
  return (
    <div id="root">
      <App />
    </div>
  );
}
