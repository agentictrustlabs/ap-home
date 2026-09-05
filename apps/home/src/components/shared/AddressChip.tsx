'use client';
// An agent, shown as the thing a person can read: its registered name when one resolves, the truncated
// address when none does. Copy still yields the ADDRESS, and the hex stays in the aria label and title —
// the address is the identity (ADR-0010) and the name is what the chain says points at it.
//
// Naming is the DEFAULT. A screen of bare hex asks the reader to recognise agents by six characters, and
// they cannot: "0x8c5c…7fe3 gave you a way to reach their treasury" names nobody. Pass `withName={false}`
// only where the hex itself is the subject.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { reverseAgentName } from '../../lib/reverse-name';
import { CopyIcon, CheckIcon } from './Icons';
import { Tooltip } from './ui';

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

export function AddressChip({ address, size = 'md', withName = true }: { address: string; size?: 'sm' | 'md'; withName?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    // Nothing to ask about: a blank or malformed value is not an agent, and asking the naming service
    // about it spends a request to learn that.
    if (!withName || !/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    let cancelled = false;
    void reverseAgentName(address as Address).then((n) => { if (!cancelled) setName(n); });
    return () => { cancelled = true; };
  }, [withName, address]);

  const label = name ?? short(address);
  return (
    <Tooltip content={copied ? 'Copied' : name ? `${name} · ${address}` : address}>
      <button
        type="button"
        className={`address-chip ${size}`}
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
    </Tooltip>
  );
}
