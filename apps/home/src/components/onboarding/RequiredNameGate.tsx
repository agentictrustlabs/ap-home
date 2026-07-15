'use client';

import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { claimName } from '../../connect-client';
import { isKmsVia, signHashFor, type Via } from '../../home/onboarding';
import { CENTRAL_AUTH_DOMAIN, nameLabel, toAgentName } from '../../lib/domain';
import { whitelabel } from '../../whitelabel/config';
import { BrandShield } from '../shared/BrandShield';

type Availability = 'idle' | 'checking' | 'available' | 'taken';

async function isNameTaken(name: string): Promise<boolean> {
  try {
    const r = await fetch(`/connect/name-info?name=${encodeURIComponent(name)}`);
    const j = (await r.json()) as { exists?: boolean };
    return !!j.exists;
  } catch {
    return false;
  }
}

export function RequiredNameGate({
  agent,
  token,
  via,
  appName,
  defaultLabel = '',
  onClaimed,
  onCancel,
}: {
  agent: Address;
  token: string;
  via: Via;
  appName: string;
  defaultLabel?: string;
  onClaimed: (name: string) => void;
  onCancel?: () => void;
}) {
  const brand = whitelabel.brand.name;
  const [value, setValue] = useState(nameLabel(defaultLabel));
  const [avail, setAvail] = useState<Availability>('idle');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const label = nameLabel(value);
  const fullName = label ? toAgentName(label) : '';
  const homeHost = label ? `${label}.${CENTRAL_AUTH_DOMAIN}` : '';

  useEffect(() => {
    if (!label) {
      setAvail('idle');
      return;
    }
    setAvail('checking');
    const t = setTimeout(async () => {
      setAvail((await isNameTaken(toAgentName(label))) ? 'taken' : 'available');
    }, 350);
    return () => clearTimeout(t);
  }, [label]);

  async function submit() {
    if (!label || avail !== 'available') return;
    setBusy(true);
    setErr('');
    try {
      const auth = isKmsVia(via) ? { token } : undefined;
      const sign = await signHashFor(via, agent, auth);
      const res = await claimName(agent, sign, label);
      if (!res.ok) {
        setErr(res.error);
        setBusy(false);
        return;
      }
      onClaimed(res.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not claim that name');
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-screen">
      <div className="onboarding-card">
        <BrandShield size={56} />
        <h1 className="onboarding-h1">Choose your {brand} name</h1>
        <p className="onboarding-sub">
          You&apos;re signed in. {appName} also needs a public {brand} name so other agents can find you.
        </p>
        <input
          className="onboarding-input"
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          placeholder="e.g. alice"
          aria-label={`Your ${brand} name`}
          autoCapitalize="none"
          spellCheck={false}
        />
        {label && (
          <div className="onboarding-name-preview">
            {fullName} <span className="onboarding-name-host">· home at {homeHost}</span>
          </div>
        )}
        {avail === 'taken' && <p className="onboarding-hint taken">That name is already taken. Choose another one.</p>}
        {avail === 'available' && <p className="onboarding-hint ok">✓ {fullName} is available</p>}
        {err && <p className="onboarding-hint taken">{err}</p>}
        <button className="btn-primary" disabled={!label || avail !== 'available' || busy} onClick={submit}>
          {busy ? 'Claiming…' : `Use ${fullName || `${brand} name`}`}
        </button>
        {onCancel && <button className="btn-ghost onboarding-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
