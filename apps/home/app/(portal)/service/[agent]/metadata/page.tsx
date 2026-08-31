'use client';
// Workspace → Manage → Metadata. The tiers of docs/architecture/agent-metadata-tiers.md, read for THIS
// agent:
//   1. VAULT (private)                 — does not apply: a service agent has no PII. Said, not hidden.
//   2. NAME RECORDS (public by choice) — editable here, published under the agent's own name.
//   3. ERC-4337 ACCOUNT (public)       — read-only; the home deliberately ships no editor.
// Same field name in two tiers is NOT the same field, and nothing here syncs one to the other (doctrine).
import { use, useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../../../src/context/session';
import { ServiceDiscoveryShell } from '../../../../../src/components/portal/discovery/ServiceDiscoveryShell';
import { readNameRecords, writeNameProperties, EDITABLE_PROPS, type EditablePropKey } from '../../../../../src/lib/name-properties';
import { readSaProfileMeta, SA_PROFILE_KEYS, type SaProfileMeta } from '../../../../../src/lib/agent-profile-meta';
import { resolveVia, signHashFor } from '../../../../../src/home/onboarding';
import { BusyButton } from '../../../../../src/components/shared/BusyButton';
import { cardSty, inputSty, mono, mutedText, errorText } from '../../../../../src/components/portal/theme';

const tierBadge = (bg: string, fg: string, text: string) => (
  <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '.15rem .5rem', borderRadius: 999, background: bg, color: fg }}>{text}</span>
);

function Tiers({ agent, name }: { agent: Address; name: string | null }) {
  const { session, profile } = useSession();
  const [records, setRecords] = useState<Partial<Record<EditablePropKey, string>> | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditablePropKey, string>>>({});
  const [sa, setSa] = useState<SaProfileMeta | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [r, p] = await Promise.all([name ? readNameRecords(name) : Promise.resolve({}), readSaProfileMeta(agent)]);
      const only: Partial<Record<EditablePropKey, string>> = {};
      for (const { key } of EDITABLE_PROPS) only[key] = (r as Record<string, string | undefined>)[key] ?? '';
      setRecords(only); setDraft(only); setSa(p);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [agent, name]);
  useEffect(() => { void load(); }, [load]);

  const changed = records ? EDITABLE_PROPS.filter(({ key }) => (draft[key] ?? '') !== (records[key] ?? '')) : [];

  const save = (): void => {
    setBusy(true); setMsg(null);
    void (async () => {
      try {
        if (!session || !name) { setMsg('This agent needs a name before its records can be published.'); return; }
        const changes: Partial<Record<EditablePropKey, string>> = {};
        for (const { key } of changed) changes[key] = draft[key] ?? '';
        const signHash = await signHashFor(resolveVia(profile?.credential, session.via), agent, { token: session.token });
        const res = await writeNameProperties(agent, name, changes, signHash);
        if (res.ok) { setRecords({ ...records, ...changes }); setMsg('Published to the name record.'); }
        else setMsg(res.error);
      } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  };

  return (
    <>
      <div style={cardSty}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
          <h3 style={{ margin: 0 }}>Private details</h3>
          {tierBadge('var(--c-g100)', 'var(--c-g500)', 'vault')}
        </div>
        <p style={{ ...mutedText, fontSize: '.82rem', margin: 0 }}>
          Not applicable to a service agent — this tier holds a person&rsquo;s PII. This agent&rsquo;s private
          working records live in its own vault and are reached through its stewardship delegation
          (Manage &rarr; Records), not here.
        </p>
      </div>

      <div style={{ ...cardSty, marginTop: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.4rem' }}>
          <h3 style={{ margin: 0 }}>Name records</h3>
          {tierBadge('#fef3c7', '#92400e', 'public by choice')}
        </div>
        {!name ? (
          <p style={{ ...mutedText, fontSize: '.82rem' }}>This agent has no name, so it has no name record to publish to.</p>
        ) : records === null ? (
          <p style={mutedText}>Reading the name record…</p>
        ) : (
          <>
            <p style={{ ...mutedText, fontSize: '.82rem', marginTop: 0 }}>
              Published under <code style={mono}>{name}</code>. Anyone who resolves the name reads these.
            </p>
            {EDITABLE_PROPS.map(({ key, label, hint }) => (
              <div key={key} style={{ marginBottom: '.7rem' }}>
                <label htmlFor={`prop-${key}`} style={{ display: 'block', fontSize: '.8rem', fontWeight: 600 }}>{label}</label>
                <span style={{ ...mutedText, fontSize: '.74rem' }}>{hint}</span>
                <input id={`prop-${key}`} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} style={{ ...inputSty, width: '100%' }} />
              </div>
            ))}
            <BusyButton className="btn-primary" busy={busy} busyLabel="Publishing…" disabled={changed.length === 0} onClick={save}>
              {changed.length === 0 ? 'No changes' : `Publish ${changed.length} change${changed.length === 1 ? '' : 's'}`}
            </BusyButton>
            {msg && <p style={{ ...mutedText, fontSize: '.82rem', marginTop: '.5rem' }}>{msg}</p>}
          </>
        )}
      </div>

      <div style={{ ...cardSty, marginTop: '1rem' }}>
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

export default function ServiceMetadataPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceDiscoveryShell agent={agent} title="Metadata">{(a, name) => <Tiers agent={a} name={name} />}</ServiceDiscoveryShell>;
}
