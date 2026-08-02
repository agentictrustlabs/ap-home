'use client';
// Who can find this agent? (spec 338 §2 / §20, W6.)
//
// THE UX PROBLEM THIS SOLVES: "nameless" reads as "broken" to a user, when it actually means four
// independent choices — do I have a public label, am I listed, who may resolve me, who may connect.
// The protocol keeps those four dimensions separate; this pane presents PRESETS over them and then
// shows the resulting dimensions, so nobody has to learn the matrix but the honest model is visible.
//
// The presets and their validation come from `@agenticprimitives/agent-resolution` — the same
// `discoveryPolicyFromPreset` / `validateDiscoveryPolicy` a resolver uses. No parallel UI copy of the
// rules, so this pane cannot drift from the protocol.

import { useMemo, useState } from 'react';
import {
  allowsDirectorySearch,
  allowsUnauthenticatedResolution,
  discoveryPolicyFromPreset,
  validateDiscoveryPolicy,
  type AgentDiscoveryPreset,
} from '@agenticprimitives/agent-resolution';
import { Card, Row, Stack } from '../../shared/ui';

interface PresetOption {
  id: AgentDiscoveryPreset;
  label: string;
  blurb: string;
}

/** Plain-language framing. The dimension table below shows what each one actually sets. */
const PRESETS: PresetOption[] = [
  { id: 'public-commercial', label: 'Public', blurb: 'Listed and resolvable by anyone. Your name and service details are public.' },
  { id: 'public-protected', label: 'Protected', blurb: 'Public identity, but service details require an authenticated caller.' },
  { id: 'private-partner', label: 'Invitation only', blurb: 'Not listed anywhere. Only parties you invite can find how to reach you.' },
  { id: 'pairwise', label: 'Pairwise', blurb: 'Each relationship gets its own private label and grant. Partners cannot correlate you.' },
  { id: 'internal-worker', label: 'Unnamed', blurb: 'No name at all. Invited parties can still reach you — namelessness is not isolation.' },
  { id: 'outbound-only', label: 'Outbound only', blurb: 'Cannot receive unsolicited connections. Your agent reaches out; nobody reaches in.' },
];

const DIMENSION_HELP: Record<string, string> = {
  naming: 'Whether you carry a human-readable label, and whether it is public.',
  listing: 'Whether you can appear in a searchable directory.',
  resolution: 'Who may look up how to reach you.',
  inbound: 'Who may open a connection to you.',
};

export function VisibilityPolicyCard({
  value,
  onChange,
}: {
  value: AgentDiscoveryPreset;
  onChange: (p: AgentDiscoveryPreset) => void;
}) {
  const [showDimensions, setShowDimensions] = useState(false);
  const policy = useMemo(() => discoveryPolicyFromPreset(value), [value]);
  const violations = useMemo(() => validateDiscoveryPolicy(policy), [policy]);

  return (
    <Card>
      <Stack gap={0.75}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Who can find this agent?</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', opacity: 0.75 }}>
            Four separate choices, not one switch. Presets set sensible combinations; open the details to
            see exactly what each one means.
          </p>
        </div>

        {/* Native div for the radiogroup role — the Stack primitive takes no ARIA props. */}
        <div role="radiogroup" aria-label="Discovery posture" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {PRESETS.map((p) => {
            const selected = p.id === value;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(p.id)}
                style={{
                  textAlign: 'left',
                  padding: '0.6rem 0.75rem',
                  borderRadius: 8,
                  border: `1px solid ${selected ? 'var(--accent, #7c5cff)' : 'var(--border, #e4e0d8)'}`,
                  background: selected ? 'var(--accent-soft, rgba(124,92,255,0.08))' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.label}</div>
                <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>{p.blurb}</div>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setShowDimensions((s) => !s)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontSize: '0.8rem', textDecoration: 'underline', opacity: 0.8 }}
        >
          {showDimensions ? 'Hide' : 'Show'} what this sets
        </button>

        {showDimensions && (
          <Stack gap={0.3} style={{ fontSize: '0.8rem' }}>
            {(['naming', 'listing', 'resolution', 'inbound'] as const).map((k) => (
              <Row key={k} justify="space-between" style={{ borderBottom: '1px solid var(--border, #eee)', paddingBottom: '0.2rem' }}>
                <span title={DIMENSION_HELP[k]} style={{ opacity: 0.75 }}>{k}</span>
                <code style={{ fontSize: '0.78rem' }}>{policy[k]}</code>
              </Row>
            ))}
            <p style={{ margin: '0.35rem 0 0', opacity: 0.7 }}>
              {allowsDirectorySearch(policy)
                ? 'This agent can appear in directory search.'
                : 'This agent will not appear in directory search.'}{' '}
              {allowsUnauthenticatedResolution(policy)
                ? 'Anyone can resolve it.'
                : 'Only parties you authorize can resolve it.'}
            </p>
          </Stack>
        )}

        {/* Should be unreachable via presets — surfaced anyway so an incoherent combination can never
            be saved silently if the preset table and the protocol ever disagree. */}
        {violations.length > 0 && (
          <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #b3261e)' }}>
            {violations.map((v) => (
              <div key={v.dimension}>{v.message}</div>
            ))}
          </div>
        )}

        <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.7 }}>
          Being findable is not being usable. Whoever can resolve you still needs a separate, revocable
          permission before they can call anything.
        </p>
      </Stack>
    </Card>
  );
}
