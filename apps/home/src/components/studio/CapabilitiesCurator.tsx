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
import { useState } from 'react';
import type { A2AAgentSkillV1, FieldBindingV1 } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { Chip, iconButtonStyle, inputStyle } from './ui';

const SOURCE_TAG: Record<string, string> = {
  'surface-catalog': 'catalog',
  'capability-claims': 'claim',
  'agent-profile': 'profile',
  user: 'manual',
  import: 'imported',
};

export function CapabilitiesCurator({
  skills,
  bindings,
  diagnostics,
  readOnly,
  onCommit,
}: {
  skills: A2AAgentSkillV1[];
  bindings: Record<string, FieldBindingV1>;
  diagnostics: ProjectionDiagnosticV1[];
  readOnly: boolean;
  onCommit(next: A2AAgentSkillV1[]): void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ id: '', name: '', description: '', tags: '' });

  // Catalog-served skills the card hasn't caught up to. The validator names them in prose; that is the only
  // candidate source this wave has — there is no Studio op that lists public capability claims.
  const catalogMissing = diagnostics
    .filter((d) => d.code === 'CATALOG_DIVERGENCE' && /catalog skill/.test(d.message))
    .map((d) => /catalog skill "([^"]+)"/.exec(d.message)?.[1])
    .filter((id): id is string => !!id && !skills.some((s) => s.id === id));

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
            <div key={`${s.id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '.45rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.45rem .6rem' }}>
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
          );
        })}
        {skills.length === 0 && <p className="manage-card-blurb">No skills on this card yet.</p>}
      </div>

      {catalogMissing.length > 0 && (
        <div style={{ marginTop: '.6rem' }}>
          <div style={{ fontSize: '.75rem', fontWeight: 700, color: 'var(--c-g700)' }}>From the surface catalog</div>
          {catalogMissing.map((id) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '.45rem', padding: '.35rem 0' }}>
              <code style={{ fontSize: '.75rem', flex: 1 }}>{id}</code>
              <Chip tone="muted">catalog</Chip>
              {!readOnly && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onCommit([...skills, { id, name: id, description: '', tags: [] }])}
                >
                  Add
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="manage-card-blurb" style={{ margin: '.6rem 0 0' }}>
        Candidates from your public capability claims aren&rsquo;t listed here yet — the Studio service reads them
        when it seeds a new card, but exposes no picker operation for them in this wave.
      </p>

      {!readOnly &&
        (adding ? (
          <div style={{ display: 'grid', gap: '.35rem', marginTop: '.5rem', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem' }}>
            <input aria-label="Skill id" placeholder="summarize-transactions" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} style={inputStyle} />
            <input aria-label="Skill name" placeholder="Summarize transactions" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
            <textarea aria-label="Skill description" placeholder="What this skill does, for another agent to read." value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={{ ...inputStyle, minHeight: 72, fontFamily: 'inherit' }} />
            <input aria-label="Tags (comma separated)" placeholder="finance, reporting" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} style={inputStyle} />
            <div style={{ display: 'flex', gap: '.4rem' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!draft.id.trim() || skills.some((s) => s.id === draft.id.trim())}
                onClick={() => {
                  onCommit([
                    ...skills,
                    {
                      id: draft.id.trim(),
                      name: draft.name.trim() || draft.id.trim(),
                      description: draft.description.trim(),
                      tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
                    },
                  ]);
                  setDraft({ id: '', name: '', description: '', tags: '' });
                  setAdding(false);
                }}
              >
                Add skill
              </button>
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={() => setAdding(true)}>
            + Add skill
          </button>
        ))}
    </div>
  );
}
