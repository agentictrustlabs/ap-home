'use client';
// The one Capabilities editor, used by person, org and service (ADR-0051).
//
// It replaces two different UIs that disagreed: a person got a free-text list whose label was slugged
// into an id, and an org or service got a comma box. Both let an agent INVENT an id, which is how two
// agents describing the same ability ended up with two ids that no matcher could reconcile. Here an
// agent SELECTS a definition, so the id is the same string everywhere by construction.
//
// Two tiers, unchanged: the record is private in the agent's vault; publishing writes only the IDS on
// chain (`atl:capabilities`), and the card and ARD project from there.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listCapabilityDefinitions, getCapabilityDefinition, capabilityDomains,
  type CatalogCapabilityDefinition,
} from '@agenticprimitives/capability-claims';
import { capabilityIdFor, type CapabilityClaim } from '../../../connect-client';
import { cardSty, btnSty, btnPrimarySty, mutedText, errorText, inputSty, pillStyle as pill } from '../theme';
import { BusyButton } from '../../shared/BusyButton';
import { publishBlockedReason } from '../../../lib/publish-gate';

export interface CapabilitiesEditorProps {
  claims: CapabilityClaim[];
  onChange(next: CapabilityClaim[]): void;
  /** Save the private record. */
  onSaveRecord(): Promise<void>;
  /** Publish the chosen ids on chain. */
  onPublish(): Promise<void>;
  /** Ids currently published on chain, so the editor can show what is already live. */
  published: string[];
  busy: 'save' | 'publish' | null;
  disabledReason?: string;
}

export function AgentCapabilitiesEditor({
  claims, onChange, onSaveRecord, onPublish, published, busy, disabledReason,
}: CapabilitiesEditorProps) {
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  const onAgent = useMemo(() => claims.map((c) => ({ claim: c, id: capabilityIdFor(c) })), [claims]);
  const held = useMemo(() => new Set(onAgent.map((r) => r.id)), [onAgent]);
  const publishedIds = useMemo(() => onAgent.filter((r) => r.claim.asserted).map((r) => r.id).sort(), [onAgent]);
  const changed = publishedIds.join('||') !== published.slice().sort().join('||');

  // WHY Publish is disabled, phrased as what to do about it (pure + tested in lib/publish-gate).
  const blockedReason = publishBlockedReason({
    total: claims.length, marked: publishedIds.length, changed, override: disabledReason,
  });

  const add = useCallback((d: CatalogCapabilityDefinition) => {
    if (held.has(d.id)) return;
    // The definition's own words are the default. An agent may override them per-card later; it should
    // not have to retype what the catalog already says.
    onChange([...claims, {
      label: d.title, capabilityId: d.id, description: d.description,
      relation: 'hasSkill', asserted: false, createdAt: Date.now(),
    }]);
  }, [claims, held, onChange]);

  const results = useMemo(
    () => listCapabilityDefinitions({ query: query || undefined, domain: domain || undefined }).slice(0, 60),
    [query, domain],
  );

  return (
    <div style={cardSty}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', marginBottom: '.7rem' }}>
        <span style={{ fontSize: '.8rem', ...mutedText }}>
          {onAgent.length === 0 ? 'Nothing selected yet.' : `${onAgent.length} selected · ${publishedIds.length} published`}
        </span>
        <a href="/capability-definitions" style={{ fontSize: '.8rem' }}>Browse all capability definitions →</a>
      </div>

      <div style={{ display: 'grid', gap: '.5rem' }}>
        {onAgent.map(({ claim: c, id }) => {
          const def = getCapabilityDefinition(id);
          return (
            <div key={id} data-capability={id} style={{ padding: '.55rem .7rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-8)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem' }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: '.9rem' }}>{def?.title ?? c.label}</span>
                  <code style={{ fontSize: '.72rem', color: 'var(--color-text-faint)', marginLeft: '.5rem' }}>{id}</code>
                  {/* A published id the catalog does not define is SHOWN and named, never dropped: it is
                      live on chain right now, and silently hiding it would leave the agent advertising
                      something its owner can no longer see (ADR-0013). */}
                  {!def && (
                    <span style={{ ...pill(false), marginLeft: '.5rem', fontSize: '.68rem' }} title="Published, but not one of the catalog's definitions — replace it from the explorer.">
                      not in catalog
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                  {/* A real button: this is the control that decides whether the id goes on chain, and as
                      a <span> it was reachable only by mouse and read as a status badge. */}
                  <button type="button" style={pill(c.asserted)} aria-label={`toggle publishing ${c.label}`}
                    aria-pressed={c.asserted}
                    title={c.asserted ? 'Published — its id is advertised on chain. Click to keep it private.' : 'Private to your record. Click to publish its id on chain.'}
                    onClick={() => onChange(claims.map((x) => (capabilityIdFor(x) === id ? { ...x, asserted: !x.asserted } : x)))}>
                    {c.asserted ? '● Published' : '○ Private'}
                  </button>
                  <button aria-label={`remove ${c.label}`} onClick={() => onChange(claims.filter((x) => capabilityIdFor(x) !== id))}
                    title="Removes it from this agent — the definition stays in the catalog."
                    style={{ border: 'none', background: 'none', color: 'var(--color-text-faint)', cursor: 'pointer', fontWeight: 800, fontSize: '1.1rem', lineHeight: 1 }}>×</button>
                </div>
              </div>
              <p style={{ fontSize: '.78rem', ...mutedText, margin: '.3rem 0 .4rem' }}>{def?.description ?? c.description ?? ''}</p>
              <input
                value={(c.examples ?? []).join(' | ')} aria-label={`example queries for ${c.label}`}
                onChange={(e) => onChange(claims.map((x) => (capabilityIdFor(x) === id ? { ...x, examples: e.target.value.split('|').map((t) => t.trim()).filter(Boolean).slice(0, 5) } : x)))}
                placeholder="example questions others might ask, separated by |  (optional, up to 5)"
                style={{ ...inputSty, fontSize: '.8rem' }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap', marginTop: onAgent.length ? '.9rem' : 0 }}>
        <button style={btnSty} onClick={() => { setPicker((v) => !v); setErr(null); }}>
          {picker ? 'Close' : '+ Add a capability'}
        </button>
        <BusyButton busy={busy === 'save'} busyLabel="Saving…" style={btnSty} onClick={() => void onSaveRecord()}>Save to your record</BusyButton>
        <BusyButton busy={busy === 'publish'} busyLabel="Publishing…" style={btnPrimarySty} onClick={() => void onPublish()}
          disabled={!!blockedReason} title={blockedReason ?? ''}>
          Publish for discovery
        </BusyButton>
      </div>
      {blockedReason && <p style={{ fontSize: '.78rem', ...mutedText, marginTop: '.5rem' }}>{blockedReason}</p>}

      {picker && (
        <div style={{ marginTop: '.9rem', paddingTop: '.8rem', borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.6rem' }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search capability definitions"
              aria-label="search capability definitions" style={{ ...inputSty, flex: 1, minWidth: 200 }} />
            <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="filter by domain" style={{ ...inputSty, minWidth: 160 }}>
              <option value="">All domains</option>
              {capabilityDomains().map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gap: '.35rem', maxHeight: 340, overflowY: 'auto' }}>
            {results.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem', padding: '.4rem .55rem', border: '1px solid var(--color-border)', borderRadius: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: '.85rem', fontWeight: 600 }}>{d.title}</span>
                  <code style={{ fontSize: '.7rem', color: 'var(--color-text-faint)', marginLeft: '.4rem' }}>{d.id}</code>
                  <p style={{ fontSize: '.76rem', ...mutedText, margin: '.15rem 0 0' }}>{d.description}</p>
                </div>
                {held.has(d.id)
                  ? <span style={{ fontSize: '.75rem', ...mutedText, whiteSpace: 'nowrap' }}>on this agent</span>
                  : <button style={btnSty} aria-label={`add ${d.id}`} onClick={() => add(d)}>Add</button>}
              </div>
            ))}
            {results.length === 0 && <p style={{ ...mutedText, fontSize: '.82rem' }}>No definition matches that. Capabilities come from the catalog — there is deliberately no way to invent one here.</p>}
          </div>
        </div>
      )}
      {err && <p style={{ ...errorText, fontSize: '.82rem', marginTop: '.5rem' }}>{err}</p>}
    </div>
  );
}
