'use client';
// /link — standalone cross-device passkey linking (spec 233 P2). Same NewDevice /
// ApproveDevice components used inline in the main sign-in flow (App.tsx); this
// page is the direct-link fallback.
import { useState } from 'react';
import { NewDevice, ApproveDevice } from '../../src/components/device-link';

export default function LinkPage() {
  const [mode, setMode] = useState<'new' | 'approve'>('new');
  return (
    <div id="root">
      <div style={{ maxWidth: 480, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 900 }}>Link a device</h1>
        <p style={{ color: '#555', fontSize: '.9rem' }}>
          Passkeys are bound to one device. Set up a passkey on a new device, then approve it from a device that already
          has yours.
        </p>
        <div style={{ display: 'flex', gap: 8, margin: '1rem 0' }}>
          <button onClick={() => setMode('new')} style={tab(mode === 'new')}>Set up THIS device</button>
          <button onClick={() => setMode('approve')} style={tab(mode === 'approve')}>Approve a device</button>
        </div>
        {mode === 'new' ? <NewDevice /> : <ApproveDevice />}
      </div>
    </div>
  );
}

const tab = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '.6rem',
  borderRadius: 8,
  border: '1px solid #ddd',
  background: active ? '#111' : '#fff',
  color: active ? '#fff' : '#111',
  fontWeight: 700,
  fontSize: '.85rem',
  cursor: 'pointer',
});
