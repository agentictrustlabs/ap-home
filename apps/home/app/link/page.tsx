'use client';
// /link — cross-device passkey linking (spec 233 P2). Two modes:
//  • "Set up this device" (NEW device): create a local passkey + post a request →
//    show a short code → poll until the original device approves → sign in.
//  • "Approve a device" (ORIGINAL device, holds the agent's existing passkey):
//    enter the code → consent → ROOT passkey signs addPasskey for the new key.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import {
  requestDeviceLink,
  lookupDeviceLink,
  approveDeviceLink,
  pollDeviceLink,
  type DeviceLinkRequest,
} from '../../src/connect-client';
import { subdomainHandle } from '../../src/lib/host';

type Mode = 'new' | 'approve';

export default function LinkPage() {
  const [mode, setMode] = useState<Mode>('new');
  return (
    <div id="root">
      <div style={{ maxWidth: 480, margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 900 }}>Link a device</h1>
        <p style={{ color: '#555', fontSize: '.9rem' }}>
          Passkeys are bound to one device. Set up a passkey on a new device, then approve it from a device that
          already has yours.
        </p>
        <div style={{ display: 'flex', gap: 8, margin: '1rem 0' }}>
          <button onClick={() => setMode('new')} style={tab(mode === 'new')}>
            Set up THIS device
          </button>
          <button onClick={() => setMode('approve')} style={tab(mode === 'approve')}>
            Approve a device
          </button>
        </div>
        {mode === 'new' ? <NewDevice /> : <ApproveDevice />}
      </div>
    </div>
  );
}

function NewDevice() {
  const [name, setName] = useState(subdomainHandle() ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const poll = useRef<{ agent: Address; digest: Hex } | null>(null);

  useEffect(() => {
    if (!code || !poll.current || linked) return;
    const t = setInterval(async () => {
      const { agent, digest } = poll.current!;
      if (await pollDeviceLink(agent, digest)) {
        setLinked(true);
        clearInterval(t);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [code, linked]);

  const start = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const out = await requestDeviceLink(name.trim());
      if (!out.ok) {
        setErr(out.error);
        return;
      }
      poll.current = { agent: out.agent, digest: out.credentialIdDigest };
      setCode(out.code);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }, [name]);

  if (linked) {
    return (
      <div style={card}>
        <p style={{ fontWeight: 700, color: '#065f46' }}>✓ This device is linked.</p>
        <a href="/" style={cta}>
          Sign in now
        </a>
      </div>
    );
  }
  if (code) {
    return (
      <div style={card}>
        <p>On a device that already has your passkey, open this same site → <b>Link a device → Approve</b>, and enter:</p>
        <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '.2em', textAlign: 'center', margin: '1rem 0' }}>
          {code}
        </div>
        <p style={{ color: '#777', fontSize: '.85rem' }}>Waiting for approval… (this device created a new passkey; it
          becomes usable once approved). Keep this tab open.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      <label style={{ fontSize: '.8rem', fontWeight: 700 }}>Your agent name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="alice" style={input} />
      <button disabled={busy || !name.trim()} onClick={start} style={cta}>
        {busy ? 'Creating passkey…' : 'Create a passkey on this device'}
      </button>
      {err && <p style={{ color: '#b91c1c', fontSize: '.85rem' }}>{err}</p>}
    </div>
  );
}

function ApproveDevice() {
  const [code, setCode] = useState('');
  const [req, setReq] = useState<DeviceLinkRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const lookup = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const out = await lookupDeviceLink(code);
      if (!out.ok) {
        setErr(out.error);
        return;
      }
      setReq(out.req);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }, [code]);

  const approve = useCallback(async () => {
    if (!req) return;
    setErr(null);
    setBusy(true);
    try {
      const out = await approveDeviceLink(req, setStep);
      if (!out.ok) {
        setErr(out.error);
        return;
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }, [req]);

  if (done) {
    return (
      <div style={card}>
        <p style={{ fontWeight: 700, color: '#065f46' }}>✓ Approved. The new device can now sign in.</p>
      </div>
    );
  }
  if (req) {
    return (
      <div style={card}>
        <p>Add a new sign-in key to <b>{req.name}</b>?</p>
        <p style={{ fontSize: '.8rem', color: '#777', wordBreak: 'break-all' }}>
          device: {req.label}<br />key fingerprint: {req.credentialIdDigest.slice(0, 18)}…
        </p>
        <p style={{ fontSize: '.8rem', color: '#b45309' }}>
          ⚠ Only approve if YOU started this on your other device. This grants that device sign-in access to your agent.
        </p>
        <button disabled={busy} onClick={approve} style={cta}>
          {busy ? (step ?? 'Approving…') : 'Approve with my passkey'}
        </button>
        {err && <p style={{ color: '#b91c1c', fontSize: '.85rem' }}>{err}</p>}
      </div>
    );
  }
  return (
    <div style={card}>
      <label style={{ fontSize: '.8rem', fontWeight: 700 }}>Code from your new device</label>
      <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" style={input} />
      <button disabled={busy || code.trim().length < 4} onClick={lookup} style={cta}>
        {busy ? 'Looking up…' : 'Continue'}
      </button>
      {err && <p style={{ color: '#b91c1c', fontSize: '.85rem' }}>{err}</p>}
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
const card: React.CSSProperties = { border: '1px solid #eee', borderRadius: 12, padding: '1.25rem', background: '#fff' };
const input: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '.6rem .75rem',
  margin: '.5rem 0 1rem',
  borderRadius: 8,
  border: '1px solid #ccc',
  fontSize: '1rem',
};
const cta: React.CSSProperties = {
  display: 'inline-block',
  width: '100%',
  padding: '.7rem',
  borderRadius: 8,
  border: 'none',
  background: '#111',
  color: '#fff',
  fontWeight: 700,
  fontSize: '.9rem',
  cursor: 'pointer',
  textAlign: 'center',
  textDecoration: 'none',
};
