'use client';
// Truncated agent address with copy-to-clipboard + brief "Copied" feedback.
// With `withName`, reverse-resolves the agent's primary name and shows it as the
// label (the chip still copies the address; the hex remains the aria/title).
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { reverseAgentName } from '../../lib/reverse-name';
import { CopyIcon, CheckIcon } from './Icons';

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function AddressChip({ address, size = 'md', withName = false }: { address: string; size?: 'sm' | 'md'; withName?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!withName) return;
    let cancelled = false;
    void reverseAgentName(address as Address).then((n) => { if (!cancelled) setName(n); });
    return () => { cancelled = true; };
  }, [withName, address]);

  const label = name ?? short(address);
  return (
    <button
      type="button"
      className={`address-chip ${size}`}
      title={name ? `${name} · ${address}` : address}
      aria-label={`Copy address ${short(address)}`}
      onClick={async () => {
        if (await copy(address)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      }}
    >
      <span className="address-chip-text">{label}</span>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied && <span className="address-chip-copied">Copied</span>}
    </button>
  );
}
