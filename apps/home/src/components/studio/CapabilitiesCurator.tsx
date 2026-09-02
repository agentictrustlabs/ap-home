'use client';
// The card's ADVERTISED CAPABILITIES — what the agent can do (ADR-0051). A2A calls this `skills[]` on the
// wire, and the raw-JSON pane is the one place a steward should see that word; here it is a capability.
//
// Read-mostly: the SOURCE is `profile.capabilities`, edited on the Capabilities page. This screen curates
// — reorder, omit, override wording for THIS card — so the profile stays the one list and a card cannot
// quietly become a second one. Entries inherited from the surface catalog or from public capability
// claims are shown with their source, since "why is this on my card?" has three different answers.
//
// A private / org-only claim never appears here at all: the absence IS the privacy boundary, so there is
// no disabled row explaining that something private exists.
//
// ADDING MEANS CHOOSING, NEVER AUTHORING. This screen used to carry a free-text id/name/description form
// beneath the very sentence telling you to edit capabilities elsewhere. An id typed there existed in no
// catalog, in no vault record and on no chain, and still travelled onto the public card and into ARD.
// That is not a lesser entry: matching works ONLY because every agent claiming a capability claims the
// same id, so an invented one is unmatchable by construction. The picker below offers what the agent has
// actually published (or its runtime serves), and nothing else.
import { useCallback, useEffect, useState } from 'react';
import type { A2AAgentSkillV1, FieldBindingV1 } from '@agenticprimitives/agent-profile/a2a';
import { getCapabilityDefinition } from '@agenticprimitives/capability-claims';
import { capabilityCandidates, type CapabilityCandidateV1 } from '../../studio-client';
import type { DelegationWire } from '../../lib/delegation';
import { Chip, iconButtonStyle } from './ui';
import { BusyButton } from '../shared/BusyButton';

const SOURCE_TAG: Record<string, string> = {
  'surface-catalog': 'catalog',
  'capability-claims': 'claim',
  'agent-profile': 'profile',
  user: 'manual',
  import: 'imported',
};

/** A card's own wording for one capability. Commits on BLUR, not per keystroke: every commit is a
 *  JSON-Patch round trip to the agent's vault, and one per character would be a request storm. */
function DescriptionField({ value, readOnly, ariaLabel, onCommit }: {
  value: string; readOnly: boolean; ariaLabel: string; onCommit(next: string): void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <textarea
      value={local}
      aria-label={ariaLabel}
      readOnly={readOnly}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      placeholder="What this capability does, for another agent to read. Required on a card."
      style={{
        width: '100%', marginTop: '.35rem', minHeight: 44, fontFamily: 'inherit', fontSize: '.78rem',
        padding: '.35rem .5rem', borderRadius: 6,
        border: `1px solid ${local.trim() ? 'var(--c-g200)' : 'var(--c-amber-400, #fbbf24)'}`,
      }}
    />
  );
}

export function CapabilitiesCurator({
  skills,
  bindings,
  readOnly,
  delegation,
  cardResourceId,
  onCommit,
}: {
  skills: A2AAgentSkillV1[];
  bindings: Record<string, FieldBindingV1>;
  readOnly: boolean;
  delegation: DelegationWire;
  cardResourceId: string;
  onCommit(next: A2AAgentSkillV1[]): void;
}) {
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<CapabilityCandidateV1[] | null>(null);
  const [unsourced, setUnsourced] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Ids this component has just added but whose patch has not come back yet. Without it the picker kept
  // offering a candidate whose `onCard` was still false server-side, so a second click added a DUPLICATE
  // — which the card schema then rejects (SKILL_ID_DUPLICATE) after the fact.
  const [adding, setAdding] = useState<Set<string>>(new Set());

  // Read the candidates whenever the card changes, not only when the picker opens: `unsourced` is a
  // finding about what is ALREADY advertised, and a finding nobody opened a panel to see is not shown.
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await capabilityCandidates(delegation, cardResourceId);
      setCandidates(r.candidates);
      setUnsourced(r.unsourced);
    } catch (e) {
      setCandidates(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [delegation, cardResourceId]);
  useEffect(() => { void load(); }, [load, skills.length]);
  useEffect(() => { setAdding((a) => (a.size ? new Set([...a].filter((id) => !skills.some((sk) => sk.id === id))) : a)); }, [skills]);

  /** Add one candidate to the card, with the catalog's own words where it has them.
   *
   *  A skill needs a DESCRIPTION to be a valid card entry, and a candidate derived from an on-chain id
   *  carries none — committing `description: ''` produced STRUCT_MISSING_FIELD on every such row. The
   *  catalog defines most ids, so use its wording; anything it does not define gets an editable
   *  description on the row, which is card WORDING and legitimately per-card (spec 347), unlike the id. */
  const addCandidate = useCallback((c: CapabilityCandidateV1) => {
    if (adding.has(c.id) || skills.some((sk) => sk.id === c.id)) return;
    const def = getCapabilityDefinition(c.id);
    setAdding((a) => new Set(a).add(c.id));
    onCommit([...skills, {
      id: c.id,
      name: def?.title ?? c.name,
      description: c.description ?? def?.description ?? '',
      tags: c.tags.length ? c.tags : (def?.domain ? [def.domain] : []),
    }]);
  }, [adding, skills, onCommit]);

  return (
    <div>
      <p className="manage-card-blurb" style={{ margin: '0 0 .5rem', fontWeight: 600 }}>
        Only what&rsquo;s listed here appears on your public card. Your other capabilities stay private.
      </p>
      <div style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--c-g700)', marginBottom: '.35rem' }}>On this card ({skills.length})</div>
      <div style={{ display: 'grid', gap: '.3rem' }}>
        {skills.map((s, i) => {
          const tag = SOURCE_TAG[bindings[`/skills/${i}`]?.source.kind ?? ''] ?? 'manual';
          return (
            <div key={`${s.id}-${i}`} style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.45rem .6rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
              <span aria-hidden style={{ color: 'var(--color-sage-700)' }}>
                ✓
              </span>
              <span style={{ fontSize: '.8rem', fontWeight: 600, flex: 1, minWidth: 0 }}>
                {s.name || s.id}
                <span style={{ color: 'var(--c-g500)', fontWeight: 400 }}> · {s.id}</span>
              </span>
              <span style={{ fontSize: '.68rem', color: 'var(--c-g500)' }}>[{tag}]</span>
              {!readOnly && (
                <button
                  type="button"
                  style={iconButtonStyle}
                  aria-label={`Remove ${s.name || s.id} from this card`}
                  title="Removes it from the card only — your capability claim is untouched."
                  onClick={() => onCommit(skills.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              )}
              </div>
              {/* The card's own WORDING for this capability. Editable per card and required by the card
                  schema — a row with none fails validation with STRUCT_MISSING_FIELD, which is how a row
                  added from a bare on-chain id used to break the card. The ID is not editable here: the
                  id is identity and must match everywhere, the prose is how THIS card explains it. */}
              <DescriptionField
                value={s.description ?? ''}
                readOnly={readOnly}
                ariaLabel={`description for ${s.name || s.id}`}
                onCommit={(next) => onCommit(skills.map((sk, j) => (j === i ? { ...sk, description: next } : sk)))}
              />
            </div>
          );
        })}
        {skills.length === 0 && <p className="manage-card-blurb">No skills on this card yet.</p>}
      </div>

      {unsourced.length > 0 && (
        <div style={{ marginTop: '.6rem', border: '1px solid var(--c-amber-300, #fcd34d)', borderRadius: 8, padding: '.5rem .6rem' }}>
          <div style={{ fontSize: '.75rem', fontWeight: 700 }}>On this card, but not claimed anywhere</div>
          <p className="manage-card-blurb" style={{ margin: '.25rem 0 0' }}>
            {unsourced.map((id) => <code key={id} style={{ marginRight: '.4rem' }}>{id}</code>)}
            — neither published in your capabilities nor served by this agent&rsquo;s runtime. Nothing can match
            an id no one else claims, so remove it here, or claim it on the Capabilities page to make it real.
          </p>
        </div>
      )}

      {!readOnly && (picking ? (
        <div style={{ marginTop: '.6rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.5rem' }}>
            <div style={{ fontSize: '.78rem', fontWeight: 700 }}>Add from what this agent publishes</div>
            <button type="button" className="btn-ghost" onClick={() => setPicking(false)}>Close</button>
          </div>
          {loadError && <p className="manage-card-blurb" style={{ color: 'var(--c-danger, #dc2626)' }}>Couldn&rsquo;t read your capabilities: {loadError}</p>}
          {candidates === null && !loadError && <p className="manage-card-blurb">Reading what this agent claims…</p>}
          {candidates?.filter((c) => !c.onCard && !skills.some((sk) => sk.id === c.id)).map((c) => (
            <div key={c.id} data-candidate={c.id} style={{ display: 'flex', alignItems: 'center', gap: '.45rem', padding: '.35rem 0', borderTop: '1px solid var(--c-g100)' }}>
              <span style={{ fontSize: '.8rem', fontWeight: 600, flex: 1, minWidth: 0 }}>
                {c.name}
                <span style={{ color: 'var(--c-g500)', fontWeight: 400 }}> · {c.id}</span>
              </span>
              <Chip tone="muted">{c.source}</Chip>
              {/* The shared busy affordance, not a hand-rolled one: pressing a button must ALWAYS
                  visibly do something, and this one waits on a vault round trip. */}
              <BusyButton
                busy={adding.has(c.id)}
                busyLabel="Adding…"
                className="btn-ghost"
                aria-label={`add ${c.id} to this card`}
                onClick={() => addCandidate(c)}
              >
                Add
              </BusyButton>
            </div>
          ))}
          {candidates !== null && candidates.every((c) => c.onCard) && (
            <p className="manage-card-blurb" style={{ marginTop: '.4rem' }}>
              {candidates.length === 0
                ? 'This agent publishes no capabilities yet. Saving one to your record keeps it PRIVATE — it is only a candidate here once you press "Publish for discovery" on the Capabilities page, which writes its id on chain. There is deliberately no way to invent one on a card.'
                : 'Everything this agent publishes is already on this card.'}
            </p>
          )}
        </div>
      ) : (
        <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={() => { setPicking(true); void load(); }}>
          + Add a capability
        </button>
      ))}
    </div>
  );
}
