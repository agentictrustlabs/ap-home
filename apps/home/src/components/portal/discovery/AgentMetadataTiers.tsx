'use client';
// The account-profile tier, read for ONE agent (docs/architecture/agent-metadata-tiers.md).
//
// Read-only on purpose: these properties are written by the flows that own them — Capabilities publishes
// `atl:skills`, saving a card writes the endpoints — and a second editor would be a second source of
// truth for the same value.
//
// The other two tiers left this file: the vault tier is Profile, and the name records are edited in
// Naming, under the name they are published with, with the same Save that points the name at the card.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { readSaProfileMeta, SA_PROFILE_KEYS, type SaProfileMeta } from '../../../lib/agent-profile-meta';
import { cardSty, mono, mutedText, errorText } from '../theme';

const tierBadge = (bg: string, fg: string, text: string) => (
  <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '.15rem .5rem', borderRadius: 999, background: bg, color: fg }}>{text}</span>
);

export function AccountProfilePanel({ agent }: { agent: Address }) {
  const [sa, setSa] = useState<SaProfileMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try { setSa(await readSaProfileMeta(agent)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [agent]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div style={cardSty}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
          <h3 style={{ margin: 0 }}>Account profile</h3>
          {tierBadge('#dbeafe', '#1e40af', 'public · read-only')}
        </div>
        <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
          Properties on the Smart Agent account itself. Read-only here on purpose: these are written by the
          flows that own them (Capabilities publishes <code style={mono}>atl:skills</code>, the Card Studio
          the endpoints), and a second editor would be a second source of truth.
        </p>
        {sa === null ? <p style={mutedText}>Reading the account…</p> : (
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.3rem .8rem', fontSize: '.84rem', margin: 0 }}>
            {SA_PROFILE_KEYS.map(({ key, label }) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt style={mutedText}>{label}</dt>
                <dd style={{ margin: 0 }}>{sa[key] ? <code style={mono}>{sa[key]}</code> : <span style={mutedText}>not set</span>}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {err && <p style={errorText}>{err}</p>}
    </>
  );
}
