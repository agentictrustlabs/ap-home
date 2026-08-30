'use client';
// The three-pane editor (design §3): section nav (left) · form (centre) · inspector (right).
// The section list, the field list and the inspector panel list are rendered DIRECTLY from
// `A2A_CARD_EDITOR_MANIFEST` — the app never hardcodes them, so a manifest change ships without a
// component edit (design §3.1).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { A2A_CARD_EDITOR_MANIFEST, VERSION_LABELS, type CardEditorFieldV1, type CardEditorSectionV1 } from '@agenticprimitives/home';
import type {
  A2AAgentCardDraftV1,
  A2AAgentCardReleaseV1,
  A2AAgentInterfaceV1,
  A2AAgentSkillV1,
  A2ASecuritySchemeV1,
} from '@agenticprimitives/agent-profile/a2a';
import { getAtPointer, setAtPointer } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import { BusyButton } from '../shared/BusyButton';
import {
  importCard,
  newMutation,
  patchDraft,
  validateCard,
  StudioCallError,
  type CardDetail,
  type DelegationWire,
  type JsonPatchOp,
} from '../../studio-client';
import { gateForOp, sectionStatus } from '../../lib/studio-view';
import { ChipListControl, ExtensionListControl, FieldShell, ReadonlyControl, SecurityRequirementsControl, TextControl, TriStateControl, useScrollToField } from './fields';
import { InterfacesEditor } from './InterfacesEditor';
import { SecuritySchemesEditor } from './SecuritySchemesEditor';
import { SkillsCurator } from './SkillsCurator';
import { Inspector, type PanelId } from './Inspector';
import type { StewardProposalV1 } from './StewardProposals';
import { Banner, ErrorLine, inputStyle } from './ui';
import { notifyCardChanged } from './useStudio';
import type { StoredProjection } from '../../studio-client';

const DOT: Record<'clean' | 'attention' | 'error', string> = {
  clean: 'var(--c-g300)',
  attention: 'var(--color-amber-500)',
  error: 'var(--c-danger)',
};

interface Conflict {
  patch: JsonPatchOp[];
  currentRevision?: number;
}

export function CardEditor({
  delegation,
  detail,
  projections,
  scopes,
  onDetail,
  onReload,
  initialPointer,
  initialDiagnostic,
  initialPanel,
  staleBanner,
}: {
  delegation: DelegationWire;
  detail: CardDetail;
  projections: readonly StoredProjection[];
  scopes: readonly string[];
  onDetail(next: CardDetail): void;
  onReload(): void;
  initialPointer?: string | null;
  initialDiagnostic?: string | null;
  /** A deep-linked `?panel=` — opens the Inspector flyout straight to that panel on load (design §1.3). */
  initialPanel?: PanelId | null;
  staleBanner?: boolean;
}) {
  const draft = detail.draft;
  const [sectionId, setSectionId] = useState<CardEditorSectionV1['id']>('identity');
  const [focusPointer, setFocusPointer] = useState<string | null>(initialPointer ?? null);
  const [diagnostics, setDiagnostics] = useState<ProjectionDiagnosticV1[]>([]);
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  // Inspector flyout — CONTROLLED here (design §4 rev.) so the last-viewed panel survives close/reopen; the
  // flyout itself never owns this state. A `?panel=`/`?diagnostic=` deep link opens it straight away.
  const [inspectorOpen, setInspectorOpen] = useState(!!initialPanel || !!initialDiagnostic);
  const [inspectorPanel, setInspectorPanel] = useState<PanelId>(initialPanel ?? (initialDiagnostic ? 'validation' : 'effective-json'));
  const [inspectorFocusPointer, setInspectorFocusPointer] = useState<string | null>(null);
  const openInspector = useCallback((panel: PanelId, pointer?: string) => {
    setInspectorPanel(panel);
    setInspectorFocusPointer(pointer ?? null);
    setInspectorOpen(true);
  }, []);
  /** The DRAFT's own lifecycle state (spec 347 §3) — `validated` is the only state a release may be cut from. */
  const draftState = detail.draft?.state ?? null;
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  const releases = detail.releases;
  const latest = releases.length > 0 ? releases[releases.length - 1] ?? null : null;
  const previousRelease: A2AAgentCardReleaseV1 | null = latest;

  // A deep link naming a diagnostic opens the owning section and focuses the field (design §1.3).
  useEffect(() => {
    if (!initialPointer) return;
    const owner = A2A_CARD_EDITOR_MANIFEST.sections.find((s) =>
      s.fields.some((f) => initialPointer === f.pointer || initialPointer.startsWith(`${f.pointer}/`)),
    );
    if (owner) setSectionId(owner.id);
  }, [initialPointer]);

  useScrollToField(focusPointer);

  const section = A2A_CARD_EDITOR_MANIFEST.sections.find((s) => s.id === sectionId) ?? A2A_CARD_EDITOR_MANIFEST.sections[0]!;
  const readOnly = !gateForOp(scopes, 'card.patchDraft').allowed || !draft;

  const diagnosticsFor = useCallback(
    (pointer: string): ProjectionDiagnosticV1[] =>
      diagnostics.filter((d) => d.sourcePointer === pointer || (d.sourcePointer ?? '').startsWith(`${pointer}/`)),
    [diagnostics],
  );

  /** One mutation = one revision. `expectedRevision` is mandatory; a stale one is a 409 we never paper over. */
  const applyPatch = useCallback(
    async (patch: JsonPatchOp[]) => {
      if (!draft) return;
      setSaving(true);
      setError(null);
      // Optimistic: paint the change now, reconcile with the server's draft on the response.
      const optimistic: A2AAgentCardDraftV1 = patch.reduce<A2AAgentCardDraftV1>(
        (d, op) => ({ ...d, card: setAtPointer(d.card, op.path, op.op === 'remove' ? undefined : op.value) }),
        draft,
      );
      onDetail({ ...detail, draft: optimistic });
      try {
        const res = await patchDraft(delegation, detail.resource.cardResourceId, patch, { ...newMutation(), expectedRevision: draft.revision }, draft.etag);
        onDetail({ ...detail, draft: res.draft });
        notifyCardChanged();
      } catch (e) {
        if (e instanceof StudioCallError && e.code === 'stale_revision') {
          setConflict({ patch, ...(e.currentRevision !== undefined ? { currentRevision: e.currentRevision } : {}) });
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
        onDetail({ ...detail, draft });
      } finally {
        setSaving(false);
      }
    },
    [delegation, detail, draft, onDetail],
  );

  const commit = useCallback(
    (pointer: string, value: unknown) => {
      void applyPatch([value === undefined ? { op: 'remove', path: pointer } : { op: 'replace', path: pointer, value }]);
    },
    [applyPatch],
  );

  const runValidate = useCallback(async () => {
    setValidating(true);
    setError(null);
    try {
      const report = await validateCard(delegation, detail.resource.cardResourceId);
      setDiagnostics(report.diagnostics);
      onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, [delegation, detail.resource.cardResourceId, onReload]);

  const runImport = useCallback(async () => {
    setImporting(true);
    setError(null);
    try {
      const report = await importCard(delegation, detail.resource.cardResourceId, { source: importText }, newMutation());
      setDiagnostics(report.diagnostics);
      setImportOpen(false);
      setImportText('');
      onReload();
      notifyCardChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [delegation, detail.resource.cardResourceId, importText, onReload]);

  const proposals = useMemo<StewardProposalV1[]>(() => [], []);

  if (!draft) {
    return (
      <div className="manage-card">
        <p className="manage-card-blurb">
          This card resource has no draft. Every release is immutable; start a new draft from the Releases tab.
        </p>
      </div>
    );
  }

  const schemeNames = Object.keys((draft.card.securitySchemes ?? {}) as Record<string, unknown>);

  const renderControl = (field: CardEditorFieldV1) => {
    const value = getAtPointer(draft.card, field.pointer);
    const diags = diagnosticsFor(field.pointer);
    switch (field.control) {
      case 'text':
      case 'url':
        return (
          <TextControl
            value={typeof value === 'string' ? value : ''}
            url={field.control === 'url'}
            readOnly={readOnly}
            ariaLabel={field.label}
            onCommit={(next) => commit(field.pointer, next === '' ? undefined : next)}
          />
        );
      case 'textarea':
        return <TextControl value={typeof value === 'string' ? value : ''} multiline readOnly={readOnly} ariaLabel={field.label} onCommit={(next) => commit(field.pointer, next)} />;
      case 'tri-state-boolean':
        return (
          <TriStateControl
            value={value}
            label={field.label}
            readOnly={readOnly}
            evidenceNeeded={diags.some((d) => d.code === 'CAPABILITY_UNVERIFIED') || field.pointer === '/capabilities/pushNotifications'}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'string-list':
      case 'mime-list':
        return (
          <ChipListControl
            values={Array.isArray(value) ? (value as string[]) : []}
            mime={field.control === 'mime-list'}
            readOnly={readOnly}
            ariaLabel={field.label}
            placeholder={field.control === 'mime-list' ? 'text/plain' : undefined}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'interface-list':
        return (
          <InterfacesEditor
            interfaces={Array.isArray(value) ? (value as A2AAgentInterfaceV1[]) : []}
            diagnostics={diags}
            readOnly={readOnly}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'security-scheme-map':
        return (
          <SecuritySchemesEditor
            schemes={(value ?? {}) as Record<string, A2ASecuritySchemeV1>}
            readOnly={readOnly}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'security-requirements':
        return (
          <SecurityRequirementsControl
            requirements={Array.isArray(value) ? (value as Array<Record<string, string[]>>) : []}
            schemeNames={schemeNames}
            readOnly={readOnly}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'skill-list':
        return (
          <SkillsCurator
            skills={Array.isArray(value) ? (value as A2AAgentSkillV1[]) : []}
            bindings={draft.fieldBindings}
            diagnostics={diags}
            readOnly={readOnly}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      case 'extension-list':
        return (
          <ExtensionListControl
            values={Array.isArray(value) ? (value as Array<{ uri: string }>) : []}
            readOnly={readOnly}
            onCommit={(next) => commit(field.pointer, next)}
          />
        );
      default:
        return <ReadonlyControl value={field.pointer === '/extendedCardPolicies' ? draft.extendedCardPolicies : value} />;
    }
  };

  return (
    <div>
      {staleBanner && (
        <Banner tone="warn">
          A source this card inherits from changed since this draft was last accepted. Fields marked{' '}
          <b>Source changed</b> still hold their old value.
        </Banner>
      )}
      {conflict && (
        <Banner
          tone="warn"
          actions={
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setConflict(null);
                  onReload();
                }}
              >
                Review their changes
              </button>
              <BusyButton
                busy={saving}
                busyLabel="Applying…"
                className="btn-ghost"
                onClick={() => {
                  const patch = conflict.patch;
                  setConflict(null);
                  onReload();
                  void applyPatch(patch);
                }}
              >
                Overwrite with mine
              </BusyButton>
            </>
          }
        >
          This draft changed while you were editing{conflict.currentRevision !== undefined ? ` (it is now revision ${conflict.currentRevision})` : ''}.
        </Banner>
      )}
      <ErrorLine error={error} />

      {/* Orientation: what this page is and how to treat it. Release-lifecycle status ("where is this
          release, what's next") lives ONCE, next to the tabs (CardStudio's lifecycle bar) — not duplicated
          here (design §3.1 rev. 2026-08-30). This block stays scoped to what's true about EDITING a draft. */}
      <div className="manage-card" style={{ marginBottom: '.7rem' }}>
        <p className="manage-card-blurb" style={{ margin: 0 }}>
          This is the card other agents fetch to learn what <b>{draft.card.name || 'this agent'}</b> does and how to reach it. Fields are
          inherited from this agent&apos;s profile, names and running service — <b>override only what must differ</b>. Editing changes
          nothing in public: a card goes live only when you release, sign and publish it.
        </p>
        {errorCount > 0 && (
          <p className="manage-card-blurb" style={{ margin: '.35rem 0 0', color: 'var(--c-danger)', display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
            <span>
              {errorCount} problem{errorCount === 1 ? '' : 's'} to fix before this draft can be released.
            </span>
            <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: '.2rem .5rem', fontSize: '.72rem' }} onClick={() => openInspector('validation')}>
              Review in Inspector
            </button>
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', marginBottom: '.7rem', alignItems: 'center' }}>
        <BusyButton
          busy={validating}
          busyLabel="Validating…"
          className={draftState === 'validated' && errorCount === 0 ? 'btn-ghost' : 'btn-primary'}
          disabled={!gateForOp(scopes, 'card.validate').allowed}
          title={gateForOp(scopes, 'card.validate').reason}
          onClick={() => void runValidate()}
        >
          Validate
        </BusyButton>
        <button
          type="button"
          className="btn-ghost"
          disabled={!gateForOp(scopes, 'card.import').allowed}
          title={gateForOp(scopes, 'card.import').reason}
          onClick={() => setImportOpen((o) => !o)}
        >
          Import an existing A2A card
        </button>
        <span style={{ flex: 1 }} />
        {/* The PERSISTENT inspector affordance (product direction, "use a flyout for right-side content
            viewer") — opens to the last-viewed panel; a red dot names the reason to look without opening it. */}
        <button
          type="button"
          className="btn-ghost"
          aria-haspopup="dialog"
          aria-expanded={inspectorOpen}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}
          onClick={() => (inspectorOpen ? setInspectorOpen(false) : openInspector(inspectorPanel))}
        >
          Inspector
          {errorCount > 0 && (
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--c-danger)', display: 'inline-block' }} />
          )}
          <span className="sr-only">{errorCount > 0 ? `, ${errorCount} problem${errorCount === 1 ? '' : 's'}` : ''}</span>
        </button>
        <span className="manage-card-blurb">
          {VERSION_LABELS.protocolVersion}: {draft.card.protocolVersion} · revision {draft.revision}
          {saving ? ' · saving…' : ''}
        </span>
      </div>

      {importOpen && (
        <div className="manage-card" style={{ marginBottom: '.7rem' }}>
          <p className="manage-card-blurb" style={{ marginBottom: '.4rem' }}>
            Paste an A2A card document. The exact bytes are kept as evidence; the import becomes a <b>proposal</b>{' '}
            draft with every field marked as hand-authored from an import — never a silent overwrite.
          </p>
          <textarea
            aria-label="A2A card JSON"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            style={{ ...inputStyle, minHeight: 160, fontFamily: 'ui-monospace, monospace', fontSize: '.72rem' }}
          />
          <div style={{ display: 'flex', gap: '.4rem', marginTop: '.4rem' }}>
            <BusyButton busy={importing} busyLabel="Importing…" className="btn-primary" disabled={!importText.trim()} onClick={() => void runImport()}>
              Import
            </BusyButton>
            <button type="button" className="btn-ghost" onClick={() => setImportOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* TWO columns now the inspector is a flyout (design §3.1 rev. 2026-08-30) — section rail + form. The
          rail is compact: a status dot and a single-line label; the section's own blurb (identical text,
          never a second hand-written copy) sits ONCE, as the form pane's own subhead, so a steward reads it
          at full width instead of clipped in a narrow column. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 240px) minmax(0, 1fr)', gap: '1.25rem', alignItems: 'start' }} className="studio-panes">
        <nav aria-label="Card sections" className="studio-sections">
          <p className="studio-sections-title">Card sections</p>
          <ul className="studio-section-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '.1rem' }}>
            {A2A_CARD_EDITOR_MANIFEST.sections.map((s) => {
              const status = sectionStatus(s, draft.fieldBindings, diagnostics);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={s.id === sectionId ? 'true' : undefined}
                    aria-label={status.label}
                    title={s.title}
                    onClick={() => setSectionId(s.id)}
                    className="studio-section-btn"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '.45rem',
                      width: '100%',
                      textAlign: 'left',
                      padding: '.5rem .55rem',
                      minHeight: 40,
                      borderRadius: 8,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '.8rem',
                      fontWeight: s.id === sectionId ? 700 : 500,
                      background: s.id === sectionId ? 'var(--c-primary-subtle)' : 'transparent',
                      color: s.id === sectionId ? 'var(--c-primary)' : 'var(--c-g700)',
                    }}
                  >
                    <span aria-hidden title={status.label} style={{ width: 8, height: 8, borderRadius: 999, background: DOT[status.status], flex: 'none' }} />
                    <span className="studio-section-label">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section aria-label={section.title}>
          <h2 className="subhead" style={{ marginTop: 0, marginBottom: '.15rem' }}>
            {section.title}
          </h2>
          <p className="manage-card-blurb" style={{ marginTop: 0, marginBottom: '.6rem' }}>{section.blurb}</p>
          {section.fields.map((f) => (
            <FieldShell
              key={f.pointer}
              field={f}
              binding={draft.fieldBindings[f.pointer]}
              diagnostics={diagnosticsFor(f.pointer)}
              focused={focusPointer === f.pointer}
              control={renderControl(f)}
              onInspect={(pointer) => openInspector(diagnosticsFor(pointer).length > 0 ? 'validation' : 'provenance', pointer)}
            />
          ))}
        </section>
      </div>

      <Inspector
        delegation={delegation}
        draft={draft}
        previousRelease={previousRelease}
        diagnostics={diagnostics}
        projections={projections}
        latestReleaseId={latest?.releaseId ?? null}
        pendingNewRelease={draft.basedOnReleaseId !== latest?.releaseId || draft.state !== 'validated'}
        proposals={proposals}
        busy={saving}
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panel={inspectorPanel}
        onPanelChange={setInspectorPanel}
        focusPointer={inspectorFocusPointer}
        onGoToField={(pointer) => {
          const owner = A2A_CARD_EDITOR_MANIFEST.sections.find((s) => s.fields.some((f) => pointer === f.pointer || pointer.startsWith(`${f.pointer}/`)));
          if (owner) setSectionId(owner.id);
          setFocusPointer(pointer);
          // "Go to field" means leaving the inspector to look at the form — close it so the field is visible.
          setInspectorOpen(false);
        }}
        onAcceptProposal={() => undefined}
        onRejectProposal={() => undefined}
      />
    </div>
  );
}
