'use client';
// Unified metadata editor — ONE page, the three tiers of docs/architecture/agent-metadata-tiers.md,
// each labeled with its visibility and edited (or not) in its canonical store:
//   1. VAULT (private, the default)      — PersonalInfoPanel (PII, encrypted, delegation-shared).
//   2. NAME RECORDS (public by choice)   — spec-314 properties, published under YOUR NAME.
//   3. ERC-4337 ACCOUNT (public, system) — read-only; the home deliberately ships no editor.
// Same field name across tiers is NOT the same field (no silent sync — doctrine).
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { SectionShell } from '../../../src/components/portal/SectionShell';
import { PersonalInfoPanel } from '../../../src/components/portal/settings/PersonalInfoPanel';
import { readNameRecords, writeNameProperties, EDITABLE_PROPS, type EditablePropKey } from '../../../src/lib/name-properties';
import { readSaProfileMeta, SA_PROFILE_KEYS, type SaProfileMeta } from '../../../src/lib/agent-profile-meta';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { cardSty, btnPrimarySty, inputSty, mono, mutedText, errorText, shortAddr } from '../../../src/components/portal/theme';

const tierBadge = (bg: string, fg: string, text: string): React.ReactNode => (
  <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '.15rem .5rem', borderRadius: 999, background: bg, color: fg }}>{text}</span>
);

/** Tier 2 — public name-record properties, edited in place (same seam as the naming page's panel). */
function NameRecordsSection({ name, agent }: { name: string; agent: Address }) {
  const { session, profile } = useSession();
  const [current, setCurrent] = useState<Partial<Record<EditablePropKey, string>> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditablePropKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    void readNameRecords(name)
      .then((r) => {
        const cur: Partial<Record<EditablePropKey, string>> = {};
        for (const { key } of EDITABLE_PROPS) { const v = r[key]; if (typeof v === 'string') cur[key] = v; }
        setCurrent(cur); setDraft(cur);
      })
      .catch((e) => setErr(String((e as Error)?.message ?? e)));
  }, [name]);
  useEffect(() => { load(); }, [load]);

  const changes: Partial<Record<EditablePropKey, string>> = {};
  if (current) {
    for (const { key } of EDITABLE_PROPS) {
      const d = (draft[key] ?? '').trim();
      if (d !== (current[key] ?? '').trim()) changes[key] = d;
    }
  }
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    if (!session) return;
    setBusy(true); setErr(null); setSaved(false);
    try {
      const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agent, { token: session.token });
      const res = await writeNameProperties(agent, name, changes, signHash);
      if (res.ok) { setSaved(true); setCurrent({ ...current, ...changes }); }
      else setErr(res.error);
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  if (!current && !err) return <p style={mutedText}>Reading your name records…</p>;
  return (
    <div>
      <div style={{ display: 'grid', gap: '.6rem' }}>
        {EDITABLE_PROPS.map(({ key, label, hint }) => (
          <label key={key} style={{ display: 'grid', gap: '.2rem', fontSize: '.82rem', color: 'var(--color-text-body)' }}>
            <span style={{ fontWeight: 700 }}>{label}</span>
            <input value={draft[key] ?? ''} onChange={(e) => { setSaved(false); setDraft((d) => ({ ...d, [key]: e.target.value })); }} placeholder={hint} style={inputSty} />
          </label>
        ))}
      </div>
      {err && <p style={{ fontSize: '.82rem', ...errorText, marginTop: '.5rem' }}>{err}</p>}
      {saved && <p style={{ fontSize: '.82rem', color: 'var(--color-sage-700, #047857)', marginTop: '.5rem' }}><strong>Saved ✓</strong> — the knowledge base is re-indexing {name}.</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '.8rem' }}>
        <button style={btnPrimarySty} onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'Signing…' : `Sign & publish${dirty ? ` (${Object.keys(changes).length})` : ''}`}
        </button>
      </div>
    </div>
  );
}

/** Tier 3 — read-only ERC-4337 account metadata. */
function SaMetaSection({ agent }: { agent: Address }) {
  const [meta, setMeta] = useState<SaProfileMeta | null>(null);
  useEffect(() => { void readSaProfileMeta(agent).then(setMeta).catch(() => setMeta({})); }, [agent]);
  if (!meta) return <p style={mutedText}>Reading on-chain account metadata…</p>;
  const rows = SA_PROFILE_KEYS.filter(({ key }) => meta[key]);
  return (
    <div>
      {rows.length === 0 ? (
        <p style={{ ...mutedText, fontSize: '.85rem', margin: 0 }}>Nothing set — this tier is written by system ceremonies only (sign-in origin, published skills).</p>
      ) : (
        <div style={{ display: 'grid', gap: '.35rem', fontSize: '.85rem' }}>
          {rows.map(({ key, label }) => (
            <div key={key}><span style={{ fontWeight: 700 }}>{label}:</span> <span style={mono}>{meta[key]}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MetadataPage() {
  const { session, agentName, agentAddress } = useSession();
  if (!session || !agentAddress) return <SectionShell title="Metadata"><p style={mutedText}>Sign in to manage your metadata.</p></SectionShell>;

  return (
    <SectionShell title="Metadata">
      <p style={{ ...mutedText, fontSize: '.85rem', margin: '0 0 1rem' }}>
        Everything about you lives in one of three tiers. Fields with the same label are <strong>not</strong> the
        same field — each tier is its own store with its own visibility.
      </p>

      {/* Tier 1 — vault (the default) */}
      <div style={{ ...cardSty, marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.35rem' }}>
          <h3 style={{ margin: 0 }}>Your details</h3>
          {tierBadge('var(--color-sage-100, #d1fae5)', 'var(--color-sage-800, #065f46)', 'Private · vault')}
        </div>
        <p style={{ ...mutedText, fontSize: '.8rem', marginTop: 0 }}>
          Encrypted in your vault. Apps and organizations see a field only through a delegation you grant — never a copy.
        </p>
        <PersonalInfoPanel agentAddress={agentAddress as Address} />
      </div>

      {/* Tier 2 — name records */}
      <div style={{ ...cardSty, marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.35rem' }}>
          <h3 style={{ margin: 0 }}>Published under your name</h3>
          {tierBadge('var(--color-amber-100, #fef3c7)', 'var(--color-amber-800, #92400e)', 'Public · by your choice')}
        </div>
        {agentName ? (
          <>
            <p style={{ ...mutedText, fontSize: '.8rem', marginTop: 0 }}>
              Anyone can read these — they are what you choose to say about yourself in the context of{' '}
              <strong style={mono as React.CSSProperties}>{agentName}</strong>. Connection records have their own
              ceremony on the <a href="/naming">Naming page</a>.
            </p>
            <NameRecordsSection name={agentName} agent={agentAddress as Address} />
          </>
        ) : (
          <p style={{ ...mutedText, fontSize: '.85rem', margin: 0 }}>
            Your home is unnamed — <a href="/naming">claim a public name</a> first; then you can publish properties under it.
          </p>
        )}
      </div>

      {/* Tier 3 — ERC-4337 account metadata (read-only) */}
      <div style={cardSty}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.35rem' }}>
          <h3 style={{ margin: 0 }}>On-chain account metadata</h3>
          {tierBadge('var(--color-g100, #f1f5f9)', 'var(--color-g600, #475569)', 'Public · system-managed')}
        </div>
        <p style={{ ...mutedText, fontSize: '.8rem', marginTop: 0 }}>
          ERC-4337 account properties keyed to <span style={mono}>{shortAddr(agentAddress)}</span> — public to
          everyone, independent of your name, and written only by system ceremonies. The home doesn&rsquo;t edit
          these day-to-day.
        </p>
        <SaMetaSection agent={agentAddress as Address} />
      </div>
    </SectionShell>
  );
}
