// Pure view helpers for the Agent Card & Projection Studio (spec 347 §9; ADR-0062).
// Design of record: `docs/agent-cards/ux-design.md` — §2.2 (list columns), §3.2 (field badges),
// §5 (diagnostic copy table), §6.1 (release stepper), §8.2/§8.3/§8.4 (projection rows, drift, losses).
//
// NO React, NO network, NO clock: every function maps a service-side record onto the PORTABLE Home
// shapes (`@agenticprimitives/home`) or onto steward-facing copy. Rendering only — nothing here grants
// anything. The scope mirrors below exist so a button can say *why* it is unavailable; the server
// re-checks every op against the presented delegation and is the only authority (design §14).
import type {
  AgentCardSummaryRowV1,
  CardEditorFieldV1,
  CardEditorSectionV1,
  DriftLabel,
  FieldBadge,
  ProjectionCenterRowV1,
  ProjectionRowState,
  StudioDuty,
  StudioScope,
} from '@agenticprimitives/home';
import { A2A_CARD_EDITOR_MANIFEST, AGENT_CARD_SCOPES, STEWARD_DEFAULT_SCOPES, dutiesOf, projectionPublishScope } from '@agenticprimitives/home';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import type {
  A2AAgentCardReleaseV1,
  A2AAgentCardV1,
  CardDraftState,
  CardReleaseState,
  FieldBindingV1,
} from '@agenticprimitives/agent-profile/a2a';
import type { ExternalIdentityBindingV1 } from '@agenticprimitives/registry-kit/projection';
import type { CardListEntry, StoredProjection } from '../studio-client';

// ── target labels ────────────────────────────────────────────────────────────────────────────────

const TARGET_LABELS: Record<string, string> = { 'ap-naming': 'AP Naming', 'ap-registry': 'AP Registry' };

/** Display name for a projection target family. Unknown families render their own id, never "unknown". */
export function targetLabel(family: string): string {
  return TARGET_LABELS[family] ?? family;
}

// ── scopes (RENDER-ONLY mirror of the service's derivation; guide.md "The transport") ────────────

/** Mirror of `OP_SCOPE` in `apps/demo-a2a/src/agent-card-studio.ts`. Used to name a missing scope in a
 *  disabled control's title — never to decide authority (the server refuses with 403 `scope_not_held`). */
export const STUDIO_OP_SCOPE = {
  'card.list': 'agent.card.read',
  'card.get': 'agent.card.read',
  'card.create': 'agent.card.draft',
  'card.patchDraft': 'agent.card.draft',
  'card.import': 'agent.card.import',
  'card.validate': 'agent.card.validate',
  'card.createRelease': 'agent.card.draft',
  'card.wellKnown': 'agent.card.read',
  'release.requestApproval': 'agent.card.draft',
  'release.approve': 'agent.card.approve',
  'release.sign': 'agent.card.sign',
  'release.publish': 'agent.card.publish',
  'release.verifyPublication': 'agent.card.publish',
  'release.deprecate': 'agent.card.publish',
  'release.revoke': 'agent.card.publish',
  'projection.list': 'agent.projection.read',
  'projection.configure': 'agent.projection.preview',
  'projection.preview': 'agent.projection.preview',
  'projection.planPublication': 'agent.projection.preview',
  'projection.requestApproval': 'agent.projection.preview',
  'projection.approve': 'agent.projection.approve',
  'binding.list': 'agent.projection.read',
  'binding.verify': 'agent.binding.verify',
} as const satisfies Record<string, StudioScope>;

export type StudioOp = keyof typeof STUDIO_OP_SCOPE;

/**
 * What the SERVER will derive for this caller (guide.md "The transport" table), reproduced so the UI can
 * render the separation-of-duties picture. A person/org principal presenting a stewardship wire holds every
 * card scope; a service agent (the Agent Metadata Steward) holds read/draft/validate/preview only.
 */
export function studioScopesFor(input: {
  principalKind: 'human' | 'service-agent';
  relationship: 'steward' | 'self' | 'member';
}): StudioScope[] {
  if (input.relationship === 'member') return [];
  if (input.principalKind === 'service-agent') return [...STEWARD_DEFAULT_SCOPES];
  return [...AGENT_CARD_SCOPES, projectionPublishScope('ap-naming'), projectionPublishScope('ap-registry')];
}

/** Which duty a scope belongs to — used for "Waiting on someone with {duty} access." (design §6.1). */
export function dutyOfScope(scope: string): StudioDuty | null {
  const [duty] = dutiesOf([scope]);
  return duty ?? null;
}

export interface Gate {
  allowed: boolean;
  /** Steward-facing sentence for a disabled control's `title` / the stepper's muted line. */
  reason?: string;
}

const DUTY_WORD: Record<StudioDuty, string> = { editor: 'edit', approver: 'approve', signer: 'sign', publisher: 'publish' };

/** Can this scope set run this op? `reason` names the duty, never the raw scope alone. */
export function gateForOp(scopes: readonly string[], op: StudioOp): Gate {
  const required: string = STUDIO_OP_SCOPE[op];
  if (scopes.includes(required)) return { allowed: true };
  const duty = dutyOfScope(required);
  return {
    allowed: false,
    reason: duty
      ? `Waiting on someone with ${DUTY_WORD[duty]} access — you don't hold ${required}.`
      : `You don't hold ${required}.`,
  };
}

/** Publishing is scoped PER target family, never blanket (`permissions.ts`). */
export function gateForPublish(scopes: readonly string[], family: string): Gate {
  const required = projectionPublishScope(family);
  if (scopes.includes(required)) return { allowed: true };
  return { allowed: false, reason: `Waiting on someone with publish access for ${targetLabel(family)} — you don't hold ${required}.` };
}

// ── cards list rows (design §2.2) ────────────────────────────────────────────────────────────────

/** `CardDraftState` (service) → the list's draft-state word. `conflict` is only knowable in the editor
 *  (it needs the field bindings), so the list never claims it. */
export function draftStateWord(state: CardDraftState | null): AgentCardSummaryRowV1['draftState'] {
  if (state === null) return 'clean';
  if (state === 'stale') return 'stale';
  if (state === 'validated') return 'clean';
  return 'dirty';
}

/** Which row actions the state machine allows RIGHT NOW, intersected with the viewer's scopes.
 *  The row never shows "Sign" on a card that hasn't been approved yet, even to a signer (design §2.2). */
export function cardActionsFor(entry: CardListEntry, scopes: readonly string[]): AgentCardSummaryRowV1['actions'] {
  const out: AgentCardSummaryRowV1['actions'] = [];
  const has = (op: StudioOp): boolean => gateForOp(scopes, op).allowed;
  if (has('card.get')) out.push('edit');
  if (entry.draftState && has('card.validate')) out.push('validate');
  if (entry.draftState === 'validated' && has('card.createRelease')) out.push('create-release');
  const rs = entry.latestRelease?.state as CardReleaseState | undefined;
  if (rs === 'validated' && has('release.requestApproval')) out.push('request-approval');
  if (rs === 'approved' && has('release.sign')) out.push('sign');
  if (rs === 'signed' && has('release.publish')) out.push('publish');
  if (rs === 'published' && has('release.deprecate')) out.push('deprecate', 'revoke');
  return out;
}

export function cardRowFrom(
  entry: CardListEntry,
  opts: { scopes: readonly string[]; projections: AgentCardSummaryRowV1['projections']; smartAgentBound?: boolean },
): AgentCardSummaryRowV1 {
  const r = entry.resource;
  return {
    type: 'ap.home.agent-card-row.v1',
    cardResourceId: r.cardResourceId,
    displayName: r.displayName ?? r.cardResourceId,
    primary: r.primary,
    environment: r.environment,
    draftState: draftStateWord(entry.draftState),
    ...(entry.latestRelease
      ? {
          latestRelease: {
            releaseId: entry.latestRelease.releaseId,
            releaseNumber: entry.latestRelease.releaseNumber,
            state: entry.latestRelease.state,
            contentDigest: entry.latestRelease.signedContentDigest ?? entry.latestRelease.unsignedContentDigest,
            signed: entry.latestRelease.signedContentDigest !== null,
            // The list endpoint does not carry the Smart Agent binding (it lives on the full release);
            // callers pass it when they already hold the detail. The UI renders the binding lock ONLY
            // when true — absence is "not shown here", never a claim that nothing is bound.
            smartAgentBound: opts.smartAgentBound ?? false,
          },
        }
      : {}),
    projections: opts.projections,
    actions: cardActionsFor(entry, opts.scopes),
  };
}

// ── projection rows (design §8.2) ────────────────────────────────────────────────────────────────

export function projectionActionsFor(state: ProjectionRowState, family: string, scopes: readonly string[]): ProjectionCenterRowV1['actions'] {
  const out: ProjectionCenterRowV1['actions'] = [];
  const has = (op: StudioOp): boolean => gateForOp(scopes, op).allowed;
  if (has('projection.configure')) out.push('configure');
  if (has('projection.preview')) out.push('preview');
  if (state === 'generated' || state === 'ready' || state === 'drifted' || state === 'stale' || state === 'published' || state === 'failed') {
    if (has('projection.planPublication')) out.push('plan');
    if (has('projection.requestApproval')) out.push('request-approval');
    if (gateForPublish(scopes, family).allowed) out.push('publish');
  }
  return out;
}

/**
 * Fold one stored projection into the portable row. Drift is only claimed where the records SUPPORT the
 * claim: a published instance whose selected card digest differs from the agent's latest release digest is
 * `source-stale`; a published instance that matches is `current`. Anything else leaves `drift` unset — the
 * remote-observation / adapter-version comparison is a service-side reconcile this wave does not expose,
 * and inventing a status here would be a silent fallback (ADR-0013).
 */
export function projectionRowFrom(
  p: StoredProjection,
  ctx: {
    scopes: readonly string[];
    latestReleaseDigest?: string | null;
    /**
     * The full binding record, when the caller has one. MANIFEST NOTE: `ProjectionCenterRowV1.binding.
     * verification` uses the binding LIFECYCLE vocabulary (`active`/`pendingVerification`/…), while
     * `ProjectionInstanceV1.lastBinding.verificationState` uses the VERIFICATION vocabulary
     * (`verified`/`unverified`/`failed`/`expired`). They are different questions, so the row is only
     * populated from a record that actually carries the lifecycle state — never by guessing a mapping.
     */
    binding?: ExternalIdentityBindingV1;
    losses?: ProjectionCenterRowV1['losses'];
    diagnostics?: ProjectionDiagnosticV1[];
    requiredActions?: string[];
    lastPublicationUri?: string;
    lastPublicationVerification?: 'valid' | 'invalid' | 'unverified';
  },
): ProjectionCenterRowV1 {
  const i = p.instance;
  const selected = i.desiredSources.selectedCardDigest;
  const drift: DriftLabel | undefined =
    i.state === 'published' && ctx.latestReleaseDigest && selected
      ? selected === ctx.latestReleaseDigest
        ? 'current'
        : 'source-stale'
      : undefined;
  return {
    type: 'ap.home.projection-row.v1',
    projectionInstanceId: i.instanceId,
    definition: {
      id: i.definition.id,
      displayName: targetLabel(i.definition.target.family),
      family: i.definition.target.family,
      targetSpecification: i.definition.target.specification,
      targetVersion: i.definition.target.version,
      adapterVersion: i.definition.adapter.version,
    },
    state: i.state,
    sourceRefs: {
      canonicalProfileDigest: i.desiredSources.canonicalProfileDigest ?? '',
      ...(p.selectedCard ? { selectedCardReleaseId: p.selectedCard.releaseId } : {}),
      ...(selected ? { selectedCardDigest: selected } : {}),
    },
    ...(i.lastArtifact
      ? { digests: { sourceBundle: i.lastArtifact.digests.sourceBundle, artifact: i.lastArtifact.artifactDigest, configuration: i.configurationDigest } }
      : {}),
    ...(ctx.binding
      ? { binding: { bindingId: ctx.binding.bindingId, externalId: ctx.binding.externalId, verification: ctx.binding.lifecycle.state } }
      : {}),
    ...(drift ? { drift } : {}),
    losses: ctx.losses ?? [],
    requiredActions: ctx.requiredActions ?? [],
    diagnostics: ctx.diagnostics ?? [],
    ...(i.lastPublication
      ? {
          lastPublication: {
            receiptId: i.lastPublication.receiptId,
            publishedAt: i.lastPublication.publishedAt,
            ...(ctx.lastPublicationUri ? { uri: ctx.lastPublicationUri } : {}),
            verification: ctx.lastPublicationVerification ?? 'unverified',
          },
        }
      : {}),
    actions: projectionActionsFor(i.state, i.definition.target.family, ctx.scopes),
  };
}

// ── drift + loss copy (design §8.3 / §8.4) ───────────────────────────────────────────────────────

export interface DriftCopy {
  line: string;
  tone: 'good' | 'warn' | 'danger' | 'muted';
  action?: string;
}

export const DRIFT_COPY: Record<DriftLabel, DriftCopy> = {
  current: { line: "Matches what's published.", tone: 'good' },
  'source-stale': { line: 'Your card changed since this was last published — republish to catch it up.', tone: 'warn', action: 'Publish update' },
  'adapter-stale': { line: 'The projection adapter was updated — this should be regenerated.', tone: 'warn', action: 'Regenerate' },
  'remote-drift': { line: "Something out there doesn't match what we published — someone or something changed it directly.", tone: 'danger', action: 'Review remote change' },
  'remote-unavailable': { line: "Couldn't check the live registry entry right now.", tone: 'muted', action: 'Try again' },
  'binding-failed': { line: "The binding to this external identity couldn't be verified.", tone: 'danger', action: 'Review' },
  'publication-superseded': { line: 'This publication was replaced by a newer one.', tone: 'muted' },
  'target-upgraded': { line: "The target's standard was updated — this projection needs review before it's trusted again.", tone: 'warn', action: 'Review' },
};

/** Lead word for a loss category — never the raw enum (design §8.4). */
export const LOSS_LEAD: Record<string, string> = {
  unsupported: 'Not supported',
  truncated: 'Shortened',
  approximateMapping: 'Approximate mapping',
  omittedByPolicy: 'Left out by policy',
  targetDefault: "Used the target's default",
  manualActionRequired: 'Needs your attention',
};

export function lossLead(category: string): string {
  return LOSS_LEAD[category] ?? category;
}

// ── the manifest, indexed by pointer ─────────────────────────────────────────────────────────────

export interface ManifestHit {
  section: CardEditorSectionV1;
  field: CardEditorFieldV1;
}

/** The field that OWNS a pointer — the longest declared pointer that prefixes it (`/skills/2/id` → `/skills`). */
export function fieldForPointer(pointer: string): ManifestHit | null {
  let best: ManifestHit | null = null;
  for (const section of A2A_CARD_EDITOR_MANIFEST.sections) {
    for (const field of section.fields) {
      if (pointer === field.pointer || pointer.startsWith(`${field.pointer}/`)) {
        if (!best || field.pointer.length > best.field.pointer.length) best = { section, field };
      }
    }
  }
  return best;
}

/** Steward-facing name for a pointer. Falls back to the pointer itself — never a blank. */
export function fieldLabelForPointer(pointer: string): string {
  return fieldForPointer(pointer)?.field.label ?? pointer;
}

export function sectionIdForPointer(pointer: string): CardEditorSectionV1['id'] | null {
  return fieldForPointer(pointer)?.section.id ?? null;
}

// ── field badges (design §3.2) ───────────────────────────────────────────────────────────────────

/**
 * One badge per effective field. A `CATALOG_DIVERGENCE` on the pointer beats the binding's own state:
 * two sources disagree and neither is recorded as chosen — that is exactly `conflict`.
 */
export function badgeFor(binding: FieldBindingV1 | undefined, diagnostics: readonly ProjectionDiagnosticV1[] = []): FieldBadge {
  if (diagnostics.some((d) => d.code === 'CATALOG_DIVERGENCE')) return 'conflict';
  if (!binding) return 'manual';
  if (binding.state === 'conflict') return 'conflict';
  if (binding.state === 'stale') return 'stale';
  if (binding.state === 'verified') return 'verified';
  if (binding.mode === 'inherit') return 'inherited';
  if (binding.mode === 'override') return 'overridden';
  if (binding.mode === 'computed') return 'computed';
  return 'manual';
}

/** Where an inherited/computed value came from, in words (design §3.2 source link). */
export const SOURCE_WORDS: Record<string, string> = {
  'agent-profile': 'From the canonical profile',
  'agent-naming': 'From this agent’s name records',
  'surface-catalog': 'From the surface catalog',
  runtime: 'From the runtime',
  'capability-claims': 'From your public capability claims',
  attestation: 'From an attestation',
  deployment: 'From the deployment',
  import: 'From an imported card',
  user: 'You set this',
};

export function sourceWords(kind: string | undefined): string {
  return (kind && SOURCE_WORDS[kind]) ?? 'Source not recorded';
}

// ── section status dots (design §3.1) ────────────────────────────────────────────────────────────

export type SectionStatus = 'clean' | 'attention' | 'error';

export function sectionStatus(
  section: CardEditorSectionV1,
  bindings: Record<string, FieldBindingV1>,
  diagnostics: readonly ProjectionDiagnosticV1[],
): { status: SectionStatus; label: string } {
  const owns = (pointer: string | undefined): boolean =>
    !!pointer && section.fields.some((f) => pointer === f.pointer || pointer.startsWith(`${f.pointer}/`));
  const mine = diagnostics.filter((d) => owns(d.sourcePointer));
  const errors = mine.filter((d) => d.severity === 'error').length;
  if (errors > 0) return { status: 'error', label: `${section.title} — ${errors} error${errors === 1 ? '' : 's'}` };
  const others = mine.length;
  const overrides = Object.entries(bindings).filter(([p, b]) => owns(p) && (b.mode === 'override' || b.state === 'stale' || b.state === 'conflict')).length;
  if (others > 0 || overrides > 0) {
    const bits: string[] = [];
    if (others > 0) bits.push(`${others} to review`);
    if (overrides > 0) bits.push(`${overrides} changed`);
    return { status: 'attention', label: `${section.title} — ${bits.join(', ')}` };
  }
  return { status: 'clean', label: `${section.title} — nothing to review` };
}

// ── diagnostics copy (design §5) ─────────────────────────────────────────────────────────────────

export interface DiagnosticView {
  code: string;
  severity: ProjectionDiagnosticV1['severity'];
  /** Steward-facing sentence. NEVER blank, never a bare code. */
  message: string;
  /** The "why" expansion — the validator's own words, so the specific value is never lost. */
  explanation?: string;
  pointer?: string;
  fix?: { kind: 'manual' | 'automatic' | 'approvalRequired'; label: string };
}

type CopyFn = (d: ProjectionDiagnosticV1, field: string) => string;

const COPY: Record<string, { copy: CopyFn; fix?: DiagnosticView['fix'] }> = {
  STRUCT_MISSING_FIELD: { copy: (_d, f) => `${f} is required.`, fix: { kind: 'manual', label: 'Go to field' } },
  STRUCT_INVALID_TYPE: { copy: (_d, f) => `${f} isn't in the right format.`, fix: { kind: 'manual', label: 'Go to field' } },
  PROTOCOL_VERSION_MISMATCH: { copy: () => 'This draft was started under an older A2A protocol version.', fix: { kind: 'automatic', label: 'Sync to pinned version' } },
  URL_NOT_ABSOLUTE: { copy: () => 'This needs a full URL, starting with https://.', fix: { kind: 'manual', label: 'Go to field' } },
  URL_NOT_HTTPS: { copy: () => 'Production cards must use https.', fix: { kind: 'manual', label: 'Go to field' } },
  MIME_TYPE_INVALID: { copy: () => "That isn't a recognized media type.", fix: { kind: 'manual', label: 'Go to field' } },
  SKILL_ID_DUPLICATE: { copy: () => 'Two skills share the same id — ids must be unique.', fix: { kind: 'manual', label: 'Go to field' } },
  SECURITY_SCHEME_INVALID: { copy: () => 'This security scheme is missing something its type requires.', fix: { kind: 'manual', label: 'Go to field' } },
  SECURITY_REF_UNRESOLVED: { copy: () => "This requirement refers to a scheme that isn't declared.", fix: { kind: 'manual', label: 'Go to field' } },
  EXTENSION_URI_INVALID: { copy: () => 'Extension URI must be a full, absolute URI.', fix: { kind: 'manual', label: 'Go to field' } },
  CANONICALIZATION_FAILED: { copy: () => "Something in this draft can't be prepared for signing." },
  JCS_NOT_REPRODUCIBLE: { copy: () => "Something in this draft can't be prepared for signing." },
  NO_INTERFACE: { copy: () => 'This card needs at least one way to reach the agent.', fix: { kind: 'manual', label: 'Go to Interfaces — Add' } },
  INTERFACE_BINDING_UNKNOWN: { copy: () => "That isn't a standard A2A binding — some clients may not recognize it.", fix: { kind: 'manual', label: 'Go to field' } },
  EXTENDED_CARD_WITHOUT_POLICY: { copy: () => 'Extended agent card is on, but no audience policy is configured.', fix: { kind: 'approvalRequired', label: 'Add audience policy' } },
  CAPABILITY_UNVERIFIED: { copy: (_d, f) => `${f} is claimed, but the running agent hasn't confirmed it yet.` },
  VERSION_EQUALS_PROTOCOL_VERSION: { copy: () => "Agent implementation version matches the A2A protocol version — that's almost always a copy-paste mistake.", fix: { kind: 'manual', label: 'Go to field' } },
  PROVIDER_MISSING: { copy: () => "No provider is declared — other agents won't know who operates this one.", fix: { kind: 'manual', label: 'Go to field' } },
  CATALOG_DIVERGENCE: { copy: () => "This doesn't match what the agent actually serves.", fix: { kind: 'approvalRequired', label: 'Keep as override' } },
  SECRET_MATERIAL_DETECTED: { copy: () => 'This looks like a key, token, or secret — it must never appear on a public card.', fix: { kind: 'manual', label: 'Go to field — remove it' } },
  PRIVATE_URL_DETECTED: { copy: () => "This points at a private or internal address — external clients can't reach it.", fix: { kind: 'manual', label: 'Go to field' } },
  VAULT_REFERENCE_DETECTED: { copy: () => 'This points into a private vault record — vault contents are never public.', fix: { kind: 'manual', label: 'Go to field — remove it' } },
  PII_SUSPECTED: { copy: () => 'This looks like it might contain personal information.', fix: { kind: 'manual', label: 'Go to field — review' } },
  UNKNOWN_FIELD: { copy: () => "This field isn't part of the A2A card model — kept for reference, not published." },
  SIGNATURE_INVALID: { copy: () => "The signature on the imported card doesn't verify." },
  SIGNATURE_UNVERIFIED: { copy: () => "The signature on the imported card couldn't be checked." },
  SOURCE_NOT_JSON: { copy: () => "That file isn't valid JSON.", fix: { kind: 'manual', label: 'Go to import — try again' } },
};

/**
 * Diagnostic → steward-facing view. Unmapped codes fall back to the validator's own `message` (which is
 * always populated) — forward-compatible with codes added after this table was written.
 */
export function diagnosticView(d: ProjectionDiagnosticV1): DiagnosticView {
  const field = d.sourcePointer ? fieldLabelForPointer(d.sourcePointer) : 'This field';
  const mapped = COPY[d.code];
  const fix = d.suggestedFix
    ? { kind: d.suggestedFix.kind, label: d.suggestedFix.kind === 'manual' ? 'Go to field' : d.suggestedFix.description }
    : mapped?.fix;
  return {
    code: d.code,
    severity: d.severity,
    message: mapped ? mapped.copy(d, field) : d.message,
    ...(d.explanation || mapped ? { explanation: d.explanation ?? d.message } : {}),
    ...(d.sourcePointer ? { pointer: d.sourcePointer } : {}),
    ...(fix ? { fix } : {}),
  };
}

export interface DiagnosticGroup {
  id: 'errors' | 'evidence' | 'warnings' | 'info';
  heading: string;
  items: DiagnosticView[];
}

/** Fixed order: errors, evidence needed (its OWN group), warnings, info (design §4.3). */
export function groupDiagnostics(diagnostics: readonly ProjectionDiagnosticV1[]): DiagnosticGroup[] {
  const views = diagnostics.map(diagnosticView);
  const pick = (s: ProjectionDiagnosticV1['severity']): DiagnosticView[] => views.filter((v) => v.severity === s);
  const groups: DiagnosticGroup[] = [
    { id: 'errors', heading: 'Errors', items: pick('error') },
    { id: 'evidence', heading: 'Evidence needed', items: pick('evidenceNeeded') },
    { id: 'warnings', heading: 'Warnings', items: pick('warning') },
    { id: 'info', heading: 'Info', items: pick('info') },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// ── release stepper (design §6.1) ────────────────────────────────────────────────────────────────

export type StepId = 'validate' | 'create-release' | 'request-approval' | 'approve' | 'sign' | 'publish' | 'verify';

export interface StepView {
  id: StepId;
  label: string;
  state: 'done' | 'current' | 'todo';
}

const STEP_ORDER: Array<{ id: StepId; label: string }> = [
  { id: 'validate', label: 'Validated' },
  { id: 'create-release', label: 'Release created' },
  { id: 'request-approval', label: 'Approval pending' },
  { id: 'approve', label: 'Approved' },
  { id: 'sign', label: 'Signed' },
  { id: 'publish', label: 'Published' },
  { id: 'verify', label: 'Verified' },
];

/** How many steps a release state has COMPLETED. Terminal states keep their high-water mark. */
function completedSteps(release: Pick<A2AAgentCardReleaseV1, 'state'> | null, draftState: CardDraftState | null): number {
  if (!release) return draftState === 'validated' ? 1 : 0;
  switch (release.state) {
    case 'validated':
      return 2;
    case 'approvalPending':
      return 3;
    case 'approved':
      return 4;
    case 'signed':
      return 5;
    case 'published':
      return 7;
    case 'superseded':
    case 'deprecated':
    case 'revoked':
      return 7;
    default:
      return 2;
  }
}

export function stepperSteps(input: { draftState: CardDraftState | null; release: Pick<A2AAgentCardReleaseV1, 'state'> | null }): StepView[] {
  const done = completedSteps(input.release, input.draftState);
  return STEP_ORDER.map((s, i) => ({ ...s, state: i < done ? 'done' : i === done ? 'current' : 'todo' }));
}

/** Which op the CURRENT step needs — so the stepper can name the duty that's blocking. */
export const STEP_OP: Record<StepId, StudioOp> = {
  validate: 'card.validate',
  'create-release': 'card.createRelease',
  'request-approval': 'release.requestApproval',
  approve: 'release.approve',
  sign: 'release.sign',
  publish: 'release.publish',
  verify: 'release.verifyPublication',
};

/** Editing at `approved` or later forks a NEW draft (spec 347 §3) — the UI must say so before it happens. */
export function editForksNewDraft(state: CardReleaseState | undefined): boolean {
  return state === 'approved' || state === 'signed' || state === 'published';
}

// ── release diff (design §4.5) ───────────────────────────────────────────────────────────────────

export interface CardDiffRow {
  pointer: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== 'object') {
    out.set(prefix || '/', JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, '[]');
    value.forEach((v, i) => flatten(v, `${prefix}/${i}`, out));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) out.set(prefix, '{}');
  for (const [k, v] of entries) flatten(v, `${prefix}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
}

/** Leaf-level diff between the previous release's card and the draft. Pure; order is pointer-sorted. */
export function diffCards(before: A2AAgentCardV1 | null, after: A2AAgentCardV1): CardDiffRow[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  if (before) flatten(before, '', a);
  flatten(after, '', b);
  const rows: CardDiffRow[] = [];
  for (const [pointer, av] of a) {
    const bv = b.get(pointer);
    if (bv === undefined) rows.push({ pointer, kind: 'removed', before: av });
    else if (bv !== av) rows.push({ pointer, kind: 'changed', before: av, after: bv });
  }
  for (const [pointer, bv] of b) if (!a.has(pointer)) rows.push({ pointer, kind: 'added', after: bv });
  return rows.sort((x, y) => x.pointer.localeCompare(y.pointer));
}

// ── projection impact (design §4.4) ──────────────────────────────────────────────────────────────

export interface ProjectionImpactRow {
  instanceId: string;
  target: string;
  drift: DriftLabel;
}

/**
 * "If you release this card as-is, here's what happens to your existing projections."
 *
 * A projection is generated from a RELEASE, so the honest comparison is release identity, not the draft's
 * bytes: a projection built from an older release is already stale, and one built from the latest release
 * goes stale the moment a newer release exists (`pendingNewRelease`). A projection that consumes no card
 * (a naming instance configured before any release) is unaffected.
 */
export function projectionImpact(
  projections: readonly StoredProjection[],
  ctx: { latestReleaseId: string | null; pendingNewRelease: boolean },
): ProjectionImpactRow[] {
  return projections.map((p) => {
    const selected = p.selectedCard?.releaseId ?? null;
    const drift: DriftLabel = !selected ? 'current' : ctx.pendingNewRelease || selected !== ctx.latestReleaseId ? 'source-stale' : 'current';
    return { instanceId: p.instance.instanceId, target: targetLabel(p.instance.definition.target.family), drift };
  });
}

// ── tri-state helper (design §3.4) ───────────────────────────────────────────────────────────────

export type TriState = 'unset' | 'no' | 'yes';

export function triStateOf(value: unknown): TriState {
  if (value === undefined || value === null) return 'unset';
  return value === true ? 'yes' : 'no';
}

export const TRI_HELP: Record<TriState, string> = {
  unset: "Not declared — clients won't see this capability mentioned at all.",
  no: 'Declared false — clients see this capability is NOT supported.',
  yes: 'Declared true — clients see this capability is supported.',
};

// ── card URI derivation (design §6.2 — the binding names the URI the card will be served from) ────

/**
 * Best-effort well-known card URI for a named agent, mirroring demo-a2a's `hostForName`: the naming zone
 * root is dropped and the remaining labels become the A2A host (`<label>.<a2aDomain>` for a person root,
 * `<label>.<type>.<a2aDomain>` for a typed suffix). The Smart Agent binding is signed BEFORE the first
 * publish, so nothing can look this up server-side yet — the value stays editable in the sign panel and
 * this is only the prefill.
 */
export function cardUriForName(name: string, opts: { nameParent: string; a2aDomain: string }): string | null {
  const labels = name.trim().toLowerCase().split('.').filter(Boolean);
  if (labels.length === 0) return null;
  if (labels[labels.length - 1] === opts.nameParent) labels.pop();
  if (labels.length === 0) return null;
  return `https://${labels.join('.')}.${opts.a2aDomain}/.well-known/agent-card.json`;
}

// ─── The live endpoint (spec 347 §8.1) ───────────────────────────────────────────────────────────────────
// "Effective JSON" is the DRAFT — what would be signed. This compares it against what the world actually
// fetches, so the three states (editing / released / served) are never conflated.

export type ServedVerdict =
  | { kind: 'unreachable'; line: string }
  | { kind: 'error'; line: string }
  | { kind: 'released-current'; line: string }
  | { kind: 'released-superseded'; line: string }
  | { kind: 'live'; line: string };

export interface ServedComparison {
  verdict: ServedVerdict;
  /** True when the served card canonicalizes to exactly the draft you are editing. */
  matchesDraft: boolean | null;
  /** True when the served BYTES are the selected release's signed bytes. */
  matchesRelease: boolean | null;
}

/** Pure: given what the endpoint served and what we hold locally, say plainly what is out there. */
export function compareServed(
  served: { reachable: boolean; status?: number; detail?: string; source?: string | null; releaseId?: string | null; servedDigest?: string; canonicalDigest?: string | null },
  local: { draftDigest?: string | null; release?: { releaseId: string; signedContentDigest?: string } | null },
): ServedComparison {
  if (!served.reachable) return { verdict: { kind: 'unreachable', line: served.detail ?? 'The endpoint could not be reached.' }, matchesDraft: null, matchesRelease: null };
  if (served.status !== undefined && served.status >= 400) {
    return { verdict: { kind: 'error', line: `The endpoint answered HTTP ${served.status}.` }, matchesDraft: null, matchesRelease: null };
  }
  const matchesDraft = served.canonicalDigest && local.draftDigest ? served.canonicalDigest === local.draftDigest : null;
  const relDigest = local.release?.signedContentDigest;
  const matchesRelease = served.servedDigest && relDigest ? served.servedDigest === relDigest : null;
  if (served.source === 'released') {
    const line = matchesRelease === false
      ? `A released card is being served, but it is not release ${local.release?.releaseId ?? '—'} — a different release is live.`
      : 'The published release is being served, byte for byte.';
    return { verdict: { kind: matchesRelease === false ? 'released-superseded' : 'released-current', line }, matchesDraft, matchesRelease };
  }
  return {
    verdict: { kind: 'live', line: 'Nothing is published yet, so the runtime builds this card on every request. Publish a release to serve fixed bytes.' },
    matchesDraft,
    matchesRelease,
  };
}

// ─── Publication verdicts ────────────────────────────────────────────────────────────────────────────────
// A receipt says valid | invalid | unverified plus a raw `detail` ("HTTP 530", "egress failed: …", a digest
// comparison). Those are the right things to RECORD and the wrong things to show a steward, who needs to know
// what happened, whether the release is safe, and what to do next.

export interface PublicationVerdict {
  tone: 'good' | 'warn';
  /** One sentence: what is true now. */
  title: string;
  /** What to do about it, or null when nothing is required. */
  next: string | null;
  /** The raw receipt detail, kept for the audit-minded — never the headline. */
  detail: string | null;
}

export function publicationVerdict(receipt: { verificationResult: string; uri?: string; detail?: string }): PublicationVerdict {
  const host = (() => { try { return receipt.uri ? new URL(receipt.uri).host : null; } catch { return null; } })();
  const where = host ? `at ${host}` : 'at your agent\'s endpoint';
  const detail = receipt.detail ?? null;
  if (receipt.verificationResult === 'valid') {
    return { tone: 'good', title: `Live and verified — this is the card being served ${where}.`, next: null, detail: null };
  }
  if (receipt.verificationResult === 'invalid') {
    return {
      tone: 'warn',
      title: `Your endpoint answered ${where}, but it is serving different bytes than this release.`,
      next: 'A newer release or a cache may be in front of it. Check again in a minute; if it persists, publish this release again.',
      detail,
    };
  }
  const d = detail ?? '';
  const status = /HTTP (\d{3})/.exec(d)?.[1];
  if (/egress failed|ENOTFOUND|refused|getaddrinfo|dns/i.test(d) || status === '530' || status === '523' || status === '522') {
    return {
      tone: 'warn',
      title: `Nothing is serving your card yet — ${host ?? 'the endpoint'} did not answer.`,
      next: `The release is signed and stored safely; only the public copy is missing. ${host ? `${host} has to resolve and route to this agent's A2A service` : "This agent needs a public A2A host"} — an operator sets that up once per Home. Then press Check again.`,
      detail,
    };
  }
  if (status === '404') {
    return {
      tone: 'warn',
      title: `${host ?? 'The endpoint'} answered, but it is not serving a card at that path yet.`,
      next: 'Publish again once the agent\'s A2A service is running there, then press Check again.',
      detail,
    };
  }
  return {
    tone: 'warn',
    title: `Published, but we could not confirm ${where} is serving it yet.`,
    next: 'This usually settles within a minute — press Check again.',
    detail,
  };
}

/** Service error code → a sentence a steward can act on. The service's codes are precise and terse
 *  (`agent_has_no_host`); showing them raw makes a dead end out of a fixable situation. */
export function studioErrorSentence(codeOrMessage: string): string {
  const c = codeOrMessage.trim();
  switch (c) {
    case 'agent_has_no_host':
    case 'the agent has no name, so no well-known host to publish at':
      return 'This agent has no public name yet, so there is nowhere on the web to publish its card. Give it a name first (Manage → Naming); the endpoint follows from the name.';
    case 'release_not_signed':
      return 'This release has to be signed before it can be published.';
    case 'scope_not_held':
      return 'You do not hold the access this step needs — someone with that role has to do it.';
    case 'stale_revision':
      return 'Someone else changed this draft while you were working. Reload to see their version before saving.';
    case 'primary_exists':
      return 'This agent already has a primary production card. Make the new one non-primary, or retire the existing one first.';
    case 'plan_not_approved':
      return 'This publication plan has not been approved, or the approval no longer matches it. Request approval again.';
    case 'no_selected_card':
      return 'Pick which card release this projection should carry before generating it.';
    default:
      return c;
  }
}
