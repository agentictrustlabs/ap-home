'use client';
// The inspector pane: a tab strip rendered from `A2A_CARD_EDITOR_MANIFEST.inspectorPanels`, always in that
// order (design §4). Effective JSON · Provenance · Validation · Projection impact · Release diff.
import { useCallback, useEffect, useState } from 'react';
import { A2A_CARD_EDITOR_MANIFEST } from '@agenticprimitives/home';
import { cardContentDigest, type A2AAgentCardDraftV1, type A2AAgentCardReleaseV1, type FieldBindingV1 } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { badgeFor, compareServed, diffCards, projectionImpact, DRIFT_COPY, fieldLabelForPointer, sourceWords } from '../../lib/studio-view';
import { fetchWellKnownCard, type DelegationWire, type StoredProjection, type WellKnownCardView } from '../../studio-client';
import { BusyButton } from '../shared/BusyButton';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { StewardProposals, type StewardProposalV1 } from './StewardProposals';
import { Chip, ErrorLine, FieldBadgeChip } from './ui';

type PanelId = (typeof A2A_CARD_EDITOR_MANIFEST.inspectorPanels)[number];

const PANEL_LABEL: Record<PanelId, string> = {
  'effective-json': 'Effective JSON',
  'live-endpoint': 'Live endpoint',
  provenance: 'Provenance',
  validation: 'Validation',
  'projection-impact': 'Projection impact',
  'release-diff': 'Release diff',
};

function EffectiveJson({ draft }: { draft: A2AAgentCardDraftV1 }) {
  const [copied, setCopied] = useState(false);
  // Unset optional booleans are OMITTED here, not `null` — this view is the honesty check on
  // `OptionalPresence` (design §4.1).
  const text = JSON.stringify(draft.card, null, 2);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.35rem' }}>
        <span className="manage-card-blurb">What actually gets signed.</span>
        <button
          type="button"
          className="btn-ghost"
          style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{ margin: 0, fontSize: '.7rem', background: 'var(--c-g50)', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem', maxHeight: 460, overflow: 'auto' }}>
        {text}
      </pre>
    </div>
  );
}

/**
 * What the world actually fetches from `/.well-known/agent-card.json` — the operational endpoint, as opposed
 * to "Effective JSON", which is the DRAFT (what WOULD be signed). Three states get conflated without this
 * view: what you are editing, what you released, and what is being served. Read-only: looking never moves a
 * release (proving a publication is the stepper's Verify step, which writes a receipt).
 */
function LiveEndpoint({
  delegation,
  draft,
  release,
}: {
  delegation: DelegationWire;
  draft: A2AAgentCardDraftV1;
  release: A2AAgentCardReleaseV1 | null;
}) {
  const [view, setView] = useState<WellKnownCardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await fetchWellKnownCard(delegation));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [delegation]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftDigest = cardContentDigest(draft.card as { signatures?: unknown });
  const cmp = view ? compareServed(view, { draftDigest, release: release ? { releaseId: release.releaseId, signedContentDigest: release.signedContentDigest } : null }) : null;
  const tone = cmp?.verdict.kind === 'released-current' ? 'var(--c-ok, #15803d)' : cmp?.verdict.kind === 'live' ? 'var(--c-g700)' : 'var(--c-warn, #b45309)';

  function download() {
    if (!view?.body) return;
    // The EXACT served bytes, not a re-serialization — a download that reformats proves nothing.
    const url = URL.createObjectURL(new Blob([view.body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-card.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <p className="manage-card-blurb" style={{ marginTop: 0 }}>
        What this agent&apos;s public endpoint is serving right now. Everything else in this inspector is about your draft.
      </p>

      {view?.uri && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem', alignItems: 'center', marginBottom: '.5rem' }}>
          <a href={view.uri} target="_blank" rel="noreferrer" style={{ fontSize: '.72rem', wordBreak: 'break-all', color: 'var(--c-primary)', fontWeight: 600 }}>
            {view.uri}
          </a>
          <button
            type="button"
            className="btn-ghost"
            style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }}
            onClick={() => {
              void navigator.clipboard?.writeText(view.uri).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy URL'}
          </button>
          <button type="button" className="btn-ghost" style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }} disabled={!view.body} onClick={download}>
            Download JSON
          </button>
          <BusyButton busy={busy} busyLabel="Fetching served card…" className="btn-ghost" style={{ minHeight: 32, padding: '.25rem .5rem', fontSize: '.72rem' }} onClick={() => void load()}>
            Refresh
          </BusyButton>
        </div>
      )}

      {error && <ErrorLine error={error} />}
      {busy && !view && <p className="manage-card-blurb">Fetching the served card…</p>}

      {view && cmp && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem', marginBottom: '.4rem' }}>
            <Chip>{view.source === 'released' ? 'Serving: released bytes' : view.source === 'live' ? 'Serving: live runtime card' : 'Serving: unknown plane'}</Chip>
            {view.releaseId && <Chip>{view.releaseId}</Chip>}
            {cmp.matchesDraft === true && <Chip>Matches your draft</Chip>}
            {cmp.matchesDraft === false && <Chip>Differs from your draft</Chip>}
          </div>
          <p style={{ fontSize: '.75rem', color: tone, margin: '0 0 .5rem' }}>{cmp.verdict.line}</p>

          {(view.servedDigest || view.canonicalDigest) && (
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '.15rem .5rem', fontSize: '.68rem', margin: '0 0 .5rem' }}>
              {view.servedDigest && (
                <>
                  <dt style={{ color: 'var(--c-g700)' }}>Served bytes</dt>
                  <dd style={{ margin: 0, wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>{view.servedDigest}</dd>
                </>
              )}
              {view.canonicalDigest && (
                <>
                  <dt style={{ color: 'var(--c-g700)' }}>Canonical</dt>
                  <dd style={{ margin: 0, wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>{view.canonicalDigest}</dd>
                </>
              )}
              <dt style={{ color: 'var(--c-g700)' }}>Your draft</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>{draftDigest}</dd>
            </dl>
          )}

          {view.body ? (
            <pre style={{ margin: 0, fontSize: '.7rem', background: 'var(--c-g50)', border: '1px solid var(--c-g200)', borderRadius: 8, padding: '.6rem', maxHeight: 380, overflow: 'auto' }}>
              {view.body}
            </pre>
          ) : (
            <p className="manage-card-blurb">{view.detail ?? 'Nothing was served.'}</p>
          )}
        </>
      )}
    </div>
  );
}

function Provenance({
  bindings,
  diagnostics,
  proposals,
  busy,
  onGoToField,
  onAcceptProposal,
  onRejectProposal,
}: {
  bindings: Record<string, FieldBindingV1>;
  diagnostics: readonly ProjectionDiagnosticV1[];
  proposals: StewardProposalV1[];
  busy: boolean;
  onGoToField(pointer: string): void;
  onAcceptProposal(p: StewardProposalV1): void;
  onRejectProposal(p: StewardProposalV1): void;
}) {
  const rows = Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b));
  const overridden = rows.filter(([, b]) => b.mode === 'override').map(([p]) => p);
  return (
    <div>
      <StewardProposals proposals={proposals} overriddenPointers={overridden} busy={busy} onAccept={onAcceptProposal} onReject={onRejectProposal} />
      <ul style={{ listStyle: 'none', margin: '.5rem 0 0', padding: 0 }}>
        {rows.map(([pointer, b]) => (
          <li key={pointer} style={{ borderBottom: '1px solid var(--c-g200)', padding: '.35rem 0' }}>
            <button
              type="button"
              onClick={() => onGoToField(pointer)}
              style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '.4rem', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: '.75rem', flex: 1, minWidth: 0, color: 'var(--c-g700)' }}>{fieldLabelForPointer(pointer)}</span>
              <FieldBadgeChip badge={badgeFor(b, diagnostics.filter((d) => d.sourcePointer === pointer))} />
            </button>
            <div style={{ fontSize: '.68rem', color: 'var(--c-g500)' }}>{sourceWords(b.source.kind)}</div>
          </li>
        ))}
        {rows.length === 0 && <p className="manage-card-blurb">No field bindings recorded yet.</p>}
      </ul>
    </div>
  );
}

function ProjectionImpact({
  projections,
  latestReleaseId,
  pendingNewRelease,
}: {
  projections: readonly StoredProjection[];
  latestReleaseId: string | null;
  pendingNewRelease: boolean;
}) {
  const rows = projectionImpact(projections, { latestReleaseId, pendingNewRelease });
  if (rows.length === 0) return <p className="manage-card-blurb">No projection targets are configured for this agent yet.</p>;
  return (
    <div>
      <p className="manage-card-blurb" style={{ margin: '0 0 .4rem' }}>
        If you release this card as-is, here&rsquo;s what happens to your existing projections.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => {
          const copy = DRIFT_COPY[r.drift];
          return (
            <li key={r.instanceId} style={{ padding: '.35rem 0', borderBottom: '1px solid var(--c-g200)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <span style={{ fontSize: '.78rem', fontWeight: 600, flex: 1 }}>{r.target}</span>
                <Chip tone={copy.tone === 'good' ? 'good' : copy.tone === 'danger' ? 'danger' : copy.tone === 'warn' ? 'warn' : 'muted'}>
                  {r.drift === 'current' ? 'No change' : 'Will go stale'}
                </Chip>
              </div>
              <p className="manage-card-blurb" style={{ margin: 0 }}>
                {copy.line}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ReleaseDiffPanel({ previous, draft }: { previous: A2AAgentCardReleaseV1 | null; draft: A2AAgentCardDraftV1 }) {
  if (!previous) return <p className="manage-card-blurb">This will be the first release.</p>;
  const rows = diffCards(previous.unsignedCard, draft.card);
  if (rows.length === 0) return <p className="manage-card-blurb">Nothing has changed since the last card release.</p>;
  const colour = { added: 'var(--color-sage-700)', removed: 'var(--c-danger)', changed: 'var(--color-amber-700)' } as const;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '.72rem' }}>
      {rows.map((r) => (
        <li key={`${r.kind}-${r.pointer}`} style={{ borderLeft: `3px solid ${colour[r.kind]}`, paddingLeft: '.5rem', margin: '.3rem 0' }}>
          <code style={{ color: 'var(--c-g700)' }}>{r.pointer}</code>
          <div style={{ color: colour[r.kind] }}>
            {r.kind === 'removed' && <s>{r.before}</s>}
            {r.kind === 'added' && <span>{r.after}</span>}
            {r.kind === 'changed' && (
              <span>
                <s>{r.before}</s> → {r.after}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Inspector(props: {
  delegation: DelegationWire;
  draft: A2AAgentCardDraftV1 | null;
  previousRelease: A2AAgentCardReleaseV1 | null;
  diagnostics: readonly ProjectionDiagnosticV1[];
  projections: readonly StoredProjection[];
  latestReleaseId: string | null;
  /** The draft has moved past the latest release — a new release is coming. */
  pendingNewRelease: boolean;
  proposals: StewardProposalV1[];
  busy: boolean;
  onGoToField(pointer: string): void;
  onAcceptProposal(p: StewardProposalV1): void;
  onRejectProposal(p: StewardProposalV1): void;
  initialPanel?: PanelId;
}) {
  const [panel, setPanel] = useState<PanelId>(props.initialPanel ?? 'effective-json');
  return (
    <aside style={{ border: '1px solid var(--c-g200)', borderRadius: 10, padding: '.7rem', background: 'var(--color-surface)' }}>
      <div role="tablist" aria-label="Inspector" style={{ display: 'flex', flexWrap: 'wrap', gap: '.25rem', marginBottom: '.6rem' }}>
        {A2A_CARD_EDITOR_MANIFEST.inspectorPanels.map((p) => (
          <button
            key={p}
            role="tab"
            type="button"
            aria-selected={panel === p}
            onClick={() => setPanel(p)}
            style={{
              fontSize: '.7rem',
              fontWeight: panel === p ? 700 : 500,
              padding: '.3rem .5rem',
              minHeight: 32,
              borderRadius: 6,
              border: '1px solid var(--c-g200)',
              cursor: 'pointer',
              background: panel === p ? 'var(--c-primary-subtle)' : 'var(--color-surface)',
              color: panel === p ? 'var(--c-primary)' : 'var(--c-g700)',
            }}
          >
            {PANEL_LABEL[p]}
          </button>
        ))}
      </div>
      {!props.draft ? (
        <p className="manage-card-blurb">No draft on this card resource.</p>
      ) : panel === 'live-endpoint' ? (
        <LiveEndpoint delegation={props.delegation} draft={props.draft} release={props.previousRelease} />
      ) : panel === 'effective-json' ? (
        <EffectiveJson draft={props.draft} />
      ) : panel === 'provenance' ? (
        <Provenance
          bindings={props.draft.fieldBindings}
          diagnostics={props.diagnostics}
          proposals={props.proposals}
          busy={props.busy}
          onGoToField={props.onGoToField}
          onAcceptProposal={props.onAcceptProposal}
          onRejectProposal={props.onRejectProposal}
        />
      ) : panel === 'validation' ? (
        <DiagnosticsPanel diagnostics={props.diagnostics} onGoToField={props.onGoToField} emptyText="Run Validate to check this draft." />
      ) : panel === 'projection-impact' ? (
        <ProjectionImpact projections={props.projections} latestReleaseId={props.latestReleaseId} pendingNewRelease={props.pendingNewRelease} />
      ) : (
        <ReleaseDiffPanel previous={props.previousRelease} draft={props.draft} />
      )}
    </aside>
  );
}
