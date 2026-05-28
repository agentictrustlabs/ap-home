'use client';
// Truncated agent address with copy-to-clipboard + brief "Copied" feedback.
import { useState } from 'react';
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

export function AddressChip({ address, size = 'md' }: { address: string; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  return (
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
      <span className="address-chip-text">{short(address)}</span>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied && <span className="address-chip-copied">Copied</span>}
    </button>
  );
}
