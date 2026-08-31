'use client';
// The metadata tiers (docs/architecture/agent-metadata-tiers.md) read for ONE managed agent — shared by
// the workspace and organization Metadata pages, because the tiers are a property of being a Smart
// Agent, not of which class it is:
//   1. VAULT (private)                 — a PERSON tier; said plainly rather than shown empty.
//   2. NAME RECORDS (public by choice) — editable here, published under the agent's own name.
//   3. ERC-4337 ACCOUNT (public)       — read-only; Capabilities and the Card Studio own those writes.
// Same field name in two tiers is NOT the same field, and nothing here syncs one to the other (doctrine).
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../context/session';
import { readNameRecords, writeNameProperties, EDITABLE_PROPS, type EditablePropKey } from '../../../lib/name-properties';
import { readSaProfileMeta, SA_PROFILE_KEYS, type SaProfileMeta } from '../../../lib/agent-profile-meta';
import { resolveVia, signHashFor } from '../../../home/onboarding';
import { BusyButton } from '../../shared/BusyButton';
import { cardSty, inputSty, mono, mutedText, errorText } from '../theme';

const tierBadge = (bg: string, fg: string, text: string) => (
  <span style={{ fontSize: '.68rem', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', padding: '.15rem .5rem', borderRadius: 999, background: bg, color: fg }}>{text}</span>
);

/** The PUBLISHED tiers of an agent's metadata, rendered under the name they are published with (spec 348
 *  §2.3). They used to sit on a `Metadata` page beside the vault tier, which put three unrelated things
 *  together because all three are "metadata" — the vault tier is now Profile, and these two live here,
 *  where the name being published is on screen.
 *
 *  `cls` is kept for the copy: an organization is not a person, and neither is a service. */
export function PublishedMetadataPanels({ agent, name, cls }: { agent: Address; name: string | null; cls: 'org' | 'service' | 'person' }) {
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
              Published under <code style={mono}>{name}</code>. Anyone who resolves the name reads these —
              including the <b>A2A endpoint</b>, which is where other agents actually send messages. It used
              to be set inside the card editor because the card needs it; it is a name record, so it is
              edited here, with the name it belongs to.
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

