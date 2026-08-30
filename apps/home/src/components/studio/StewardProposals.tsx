'use client';
// Agent Metadata Steward proposals (design §7). Every field the steward proposes is a SUGGESTION — the
// human's Accept click is the authorship event; the AI's draft is the input. The steward may draft,
// validate, preview and explain; it can never sign, publish, transact, or mark anything verified
// (`STEWARD_FORBIDDEN_SCOPES`).
//
// SERVICE GAP (this wave): no Studio operation returns steward proposals — `apps/demo-a2a/src/
// agent-card-studio.ts` exposes card/release/projection/binding ops only, and a service-agent caller
// writes into the draft directly under `STEWARD_DEFAULT_SCOPES` rather than into a proposal queue. The
// renderer below is complete and takes its list as a prop; with no source wired it renders the honest
// absence rather than pretending a steward is watching.
import type { ReactNode } from 'react';
import { fieldLabelForPointer } from '../../lib/studio-view';
import { Chip } from './ui';

export interface StewardProposalV1 {
  proposalId: string;
  pointer: string;
  value: unknown;
  /** Where the steward got it ("this agent's 12 most recent completed skill runs"). */
  source: string;
  explanation: string;
  /** Qualitative — never a fabricated percentage (design §7). */
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
  privacyClass: 'public' | 'audience' | 'never-public';
}

export function StewardProposalCard({
  proposal,
  /** True when the human already overrode this field in this session — Accept relabels and confirms twice. */
  replacesOverride,
  busy,
  onAccept,
  onReject,
}: {
  proposal: StewardProposalV1;
  replacesOverride: boolean;
  busy: boolean;
  onAccept(): void;
  onReject(): void;
}) {
  // A `never-public` proposal aimed at a public card is a contradiction: render it as refused, with the
  // reason, never as an acceptable suggestion.
  const refused = proposal.privacyClass === 'never-public';
  return (
    <div style={{ border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.65rem', marginBottom: '.5rem', background: 'var(--c-g50)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.35rem', marginBottom: '.35rem' }}>
        <span aria-hidden>🤖</span>
        <span style={{ fontSize: '.78rem', fontWeight: 700 }}>Proposed by your Metadata Steward</span>
      </div>
      <div style={{ fontSize: '.75rem', color: 'var(--c-g500)' }}>{fieldLabelForPointer(proposal.pointer)}</div>
      <pre style={{ margin: '.25rem 0', fontSize: '.75rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {typeof proposal.value === 'string' ? proposal.value : JSON.stringify(proposal.value, null, 2)}
      </pre>
      <p className="manage-card-blurb" style={{ margin: '.2rem 0' }}>
        Why: {proposal.explanation}
      </p>
      <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap', margin: '.3rem 0' }}>
        <Chip tone="muted">Confidence: {proposal.confidence}</Chip>
        <Chip tone="muted">Evidence: {proposal.evidence.length}</Chip>
        <Chip tone={refused ? 'danger' : 'muted'}>Privacy class: {proposal.privacyClass}</Chip>
      </div>
      {refused ? (
        <p className="manage-card-blurb" style={{ color: 'var(--c-danger)', margin: 0 }}>
          Your Metadata Steward flagged this as private — it won&rsquo;t propose it for a public card.
        </p>
      ) : (
        <div style={{ display: 'flex', gap: '.4rem' }}>
          <button type="button" className="btn-primary" disabled={busy} onClick={onAccept}>
            {replacesOverride ? 'Replace your override' : 'Accept'}
          </button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onReject}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export function StewardProposals({
  proposals,
  overriddenPointers,
  busy,
  onAccept,
  onReject,
  empty,
}: {
  proposals: StewardProposalV1[];
  overriddenPointers: readonly string[];
  busy: boolean;
  onAccept(p: StewardProposalV1): void;
  onReject(p: StewardProposalV1): void;
  empty?: ReactNode;
}) {
  if (proposals.length === 0) {
    return (
      <>
        {empty ?? (
          <p className="manage-card-blurb">
            No proposals from a Metadata Steward. This Home has no steward operation to read them from in this
            wave — every field below was authored or inherited, never suggested.
          </p>
        )}
      </>
    );
  }
  return (
    <div>
      {proposals.map((p) => (
        <StewardProposalCard
          key={p.proposalId}
          proposal={p}
          replacesOverride={overriddenPointers.includes(p.pointer)}
          busy={busy}
          onAccept={() => onAccept(p)}
          onReject={() => onReject(p)}
        />
      ))}
    </div>
  );
}
