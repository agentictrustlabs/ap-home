'use client';
// Cross-device passkey linking UI (spec 233 P2), shared by the standalone /link
// page AND inline in the main sign-in flow (App.tsx). Two pieces:
//  • <NewDevice>     — THIS (new) device: create a local passkey + post a request →
//                      show a code → poll until the original device approves.
//  • <ApproveDevice> — the ORIGINAL device (holds the agent's passkey): enter the
//                      code → consent → ROOT passkey signs addPasskey.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from '@agenticprimitives/types';
import {
  requestDeviceLink,
  lookupDeviceLink,
  approveDeviceLink,
  pollDeviceLink,
  type DeviceLinkRequest,
} from '../connect-client';

/** NEW device: register a local passkey + request a link; poll until approved. */
export function NewDevice({ prefillName = '', onLinked }: { prefillName?: string; onLinked?: () => void }) {
  const [name, setName] = useState(prefillName);
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
        onLinked?.();
        clearInterval(t);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [code, linked, onLinked]);

  const start = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const out = await requestDeviceLink(name.trim());
      if (!out.ok) return setErr(out.error);
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
      <div className="scard" style={{ marginTop: '.75rem' }}>
        <p style={{ fontWeight: 700, color: 'var(--c-success)', margin: 0 }}>✓ This device is linked. Sign in above.</p>
      </div>
    );
  }
  if (code) {
    const home = typeof window !== 'undefined' ? window.location.origin : '';
    const homeShort = home.replace(/^https?:\/\//, '');
    return (
      <div className="scard" style={{ marginTop: '.75rem' }}>
        <p style={{ fontSize: '.85rem', margin: '0 0 .5rem' }}>
          On the device that <b>already has your passkey</b>:
        </p>
        <ol style={{ fontSize: '.82rem', margin: '0 0 .6rem', paddingLeft: '1.15rem', lineHeight: 1.5 }}>
          <li>
            Open <a href={home} style={{ fontWeight: 700 }}>{homeShort}</a> and sign in.
          </li>
          <li>Choose <b>“Add another device”</b>.</li>
          <li>Enter this code:</li>
        </ol>
        <div style={{ fontSize: '1.75rem', fontWeight: 900, letterSpacing: '.2em', textAlign: 'center', margin: '.25rem 0 .5rem' }}>
          {code}
        </div>
        <p className="muted" style={{ fontSize: '.78rem', margin: 0 }}>
          Waiting for approval… keep this tab open.
        </p>
      </div>
    );
  }
  return (
    <div className="scard" style={{ marginTop: '.75rem' }}>
      <p style={{ fontSize: '.85rem', margin: '0 0 .5rem' }}>
        No passkey for this agent on <b>this</b> device? Create one here, then approve it from your original device.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ''))}
        placeholder="your agent name"
        aria-label="Agent name"
        style={{ marginBottom: '.5rem' }}
      />
      <button disabled={busy || !name.trim()} onClick={start} style={{ fontSize: '.85rem' }}>
        {busy ? 'Creating passkey…' : 'Set up this device'}
      </button>
      {err && <p role="alert" style={{ fontSize: '.8rem', color: 'var(--c-danger)', margin: '.5rem 0 0' }}>{err}</p>}
    </div>
  );
}

/** ORIGINAL device: enter the new device's code → consent → ROOT signs addPasskey. */
export function ApproveDevice({ onApproved }: { onApproved?: () => void }) {
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
      if (!out.ok) return setErr(out.error);
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
      if (!out.ok) return setErr(out.error);
      setDone(true);
      onApproved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }, [req, onApproved]);

  if (done) {
    return (
      <div className="scard" style={{ marginTop: '.75rem' }}>
        <p style={{ fontWeight: 700, color: 'var(--c-success)', margin: 0 }}>✓ Approved — the new device can sign in now.</p>
      </div>
    );
  }
  if (req) {
    return (
      <div className="scard" style={{ marginTop: '.75rem' }}>
        <p style={{ margin: '0 0 .35rem' }}>Add a new sign-in key to <b>{req.name}</b>?</p>
        <p className="muted" style={{ fontSize: '.78rem', margin: '0 0 .35rem', wordBreak: 'break-all' }}>
          device: {req.label} · key {req.credentialIdDigest.slice(0, 14)}…
        </p>
        <p style={{ fontSize: '.78rem', color: 'var(--c-warning, #b45309)', margin: '0 0 .5rem' }}>
          ⚠ Only approve if YOU started this on your other device.
        </p>
        <button disabled={busy} onClick={approve} style={{ fontSize: '.85rem' }}>
          {busy ? (step ?? 'Approving…') : 'Approve with my passkey'}
        </button>
        {err && <p role="alert" style={{ fontSize: '.8rem', color: 'var(--c-danger)', margin: '.5rem 0 0' }}>{err}</p>}
      </div>
    );
  }
  return (
    <div className="scard" style={{ marginTop: '.75rem' }}>
      <p style={{ fontSize: '.85rem', margin: '0 0 .5rem' }}>Enter the code shown on the new device:</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="ABC123"
        aria-label="Device code"
        style={{ marginBottom: '.5rem' }}
      />
      <button disabled={busy || code.trim().length < 4} onClick={lookup} style={{ fontSize: '.85rem' }}>
        {busy ? 'Looking up…' : 'Continue'}
      </button>
      {err && <p role="alert" style={{ fontSize: '.8rem', color: 'var(--c-danger)', margin: '.5rem 0 0' }}>{err}</p>}
    </div>
  );
}
