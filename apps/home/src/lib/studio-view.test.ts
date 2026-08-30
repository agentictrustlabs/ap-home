import { describe, expect, it } from 'vitest';
import { AGENT_CARD_SCOPES, STEWARD_DEFAULT_SCOPES } from '@agenticprimitives/home';
import type { A2AAgentCardV1 } from '@agenticprimitives/agent-profile/a2a';
import type { ProjectionDiagnosticV1 } from '@agenticprimitives/types';
import {
  badgeFor,
  cardActionsFor,
  cardUriForName,
  diagnosticView,
  diffCards,
  draftStateWord,
  fieldLabelForPointer,
  gateForOp,
  gateForPublish,
  groupDiagnostics,
  lifecycleOrientation,
  lossLead,
  namesAndBindingsRows,
  projectionImpact,
  projectionRowFrom,
  sectionIdForPointer,
  sectionStatus,
  stepperSteps,
  studioScopesFor,
  targetLabel,
  triStateOf,
  compareServed,
  publicationVerdict,
  studioErrorSentence,
} from './studio-view';
import type { CardListEntry, StoredProjection } from '../studio-client';
import { A2A_CARD_EDITOR_MANIFEST } from '@agenticprimitives/home';

const HUMAN = studioScopesFor({ principalKind: 'human', relationship: 'steward' });

const entry = (over: Partial<CardListEntry> = {}): CardListEntry => ({
  resource: {
    cardResourceId: 'card-1',
    canonicalAgentId: 'eip155:84532:0xabc',
    environment: 'production',
    primary: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  draftState: 'draft',
  draftRevision: 1,
  latestRelease: null,
  servedReleaseId: null,
  ...over,
});

describe('studio scopes + duty gating', () => {
  it('a human steward holds every card scope plus both publish families', () => {
    for (const s of AGENT_CARD_SCOPES) expect(HUMAN).toContain(s);
    expect(gateForPublish(HUMAN, 'ap-naming').allowed).toBe(true);
    expect(gateForPublish(HUMAN, 'ap-registry').allowed).toBe(true);
  });

  it('a service agent (Metadata Steward) never holds sign / publish / approve', () => {
    const steward = studioScopesFor({ principalKind: 'service-agent', relationship: 'steward' });
    expect(steward).toEqual([...STEWARD_DEFAULT_SCOPES]);
    expect(gateForOp(steward, 'release.sign').allowed).toBe(false);
    expect(gateForOp(steward, 'release.publish').allowed).toBe(false);
    expect(gateForOp(steward, 'release.approve').allowed).toBe(false);
    expect(gateForOp(steward, 'card.validate').allowed).toBe(true);
  });

  it('a plain member holds nothing', () => {
    expect(studioScopesFor({ principalKind: 'human', relationship: 'member' })).toEqual([]);
  });

  it('a refusal names the DUTY, not just the scope', () => {
    const g = gateForOp(STEWARD_DEFAULT_SCOPES, 'release.approve');
    expect(g.reason).toContain('approve access');
    expect(g.reason).toContain('agent.card.approve');
  });

  it('publish refusal names the target family', () => {
    expect(gateForPublish([], 'ap-registry').reason).toContain('AP Registry');
  });
});

describe('cards list rows', () => {
  it('never offers a step the state machine has not reached', () => {
    expect(cardActionsFor(entry(), HUMAN)).toEqual(['edit', 'validate']);
    expect(cardActionsFor(entry({ draftState: 'validated' }), HUMAN)).toContain('create-release');
    const approved = entry({ latestRelease: { releaseId: 'r1', state: 'approved', releaseNumber: 1, unsignedContentDigest: `sha256:${'a'.repeat(64)}`, signedContentDigest: null } });
    expect(cardActionsFor(approved, HUMAN)).toContain('sign');
    expect(cardActionsFor(approved, HUMAN)).not.toContain('publish');
    const signed = entry({ latestRelease: { ...approved.latestRelease!, state: 'signed' } });
    expect(cardActionsFor(signed, HUMAN)).toContain('publish');
    expect(cardActionsFor(signed, HUMAN)).not.toContain('sign');
  });

  it('omits missing-scope actions entirely (absent reads as "not your job")', () => {
    expect(cardActionsFor(entry({ draftState: 'validated' }), ['agent.card.read'])).toEqual(['edit']);
  });

  it('maps draft state honestly and never claims conflict from the list', () => {
    expect(draftStateWord(null)).toBe('clean');
    expect(draftStateWord('validated')).toBe('clean');
    expect(draftStateWord('draft')).toBe('dirty');
    expect(draftStateWord('stale')).toBe('stale');
  });
});

describe('release stepper state', () => {
  const at = (steps: ReturnType<typeof stepperSteps>, id: string) => steps.find((s) => s.id === id)!;

  it('an unvalidated draft is at step one', () => {
    const s = stepperSteps({ draftState: 'draft', release: null });
    expect(at(s, 'validate').state).toBe('current');
    expect(at(s, 'sign').state).toBe('todo');
  });

  it('a validated draft has finished validation and waits on the release', () => {
    const s = stepperSteps({ draftState: 'validated', release: null });
    expect(at(s, 'validate').state).toBe('done');
    expect(at(s, 'create-release').state).toBe('current');
  });

  it('walks approvalPending → approved → signed → published', () => {
    expect(at(stepperSteps({ draftState: null, release: { state: 'approvalPending' } }), 'approve').state).toBe('current');
    expect(at(stepperSteps({ draftState: null, release: { state: 'approved' } }), 'sign').state).toBe('current');
    expect(at(stepperSteps({ draftState: null, release: { state: 'signed' } }), 'publish').state).toBe('current');
    const published = stepperSteps({ draftState: null, release: { state: 'published' } });
    expect(published.every((s) => s.state === 'done')).toBe(true);
  });

  it('a terminal release keeps its high-water mark rather than reopening steps', () => {
    expect(stepperSteps({ draftState: null, release: { state: 'revoked' } }).every((s) => s.state === 'done')).toBe(true);
  });
});

describe('field-row mapping', () => {
  it('resolves the owning field for a nested pointer', () => {
    expect(fieldLabelForPointer('/skills/2/id')).toBe('Skills');
    expect(sectionIdForPointer('/capabilities/streaming')).toBe('capabilities');
    expect(fieldLabelForPointer('/nope')).toBe('/nope');
  });

  it('never calls the agent implementation version plain "Version"', () => {
    const identity = A2A_CARD_EDITOR_MANIFEST.sections.find((s) => s.id === 'identity')!;
    expect(identity.fields.find((f) => f.pointer === '/version')!.label).toBe('Agent implementation version');
  });

  it('badges follow the binding, with catalog divergence winning', () => {
    const base = { pointer: '/name', source: { kind: 'agent-profile' as const }, updatedAt: 'now' };
    expect(badgeFor({ ...base, mode: 'inherit', state: 'fresh' })).toBe('inherited');
    expect(badgeFor({ ...base, mode: 'override', state: 'fresh' })).toBe('overridden');
    expect(badgeFor({ ...base, mode: 'computed', state: 'fresh' })).toBe('computed');
    expect(badgeFor({ ...base, mode: 'inherit', state: 'stale' })).toBe('stale');
    expect(badgeFor({ ...base, mode: 'inherit', state: 'verified' })).toBe('verified');
    expect(badgeFor(undefined)).toBe('manual');
    expect(badgeFor({ ...base, mode: 'inherit', state: 'fresh' }, [{ code: 'CATALOG_DIVERGENCE', severity: 'error', message: 'x' }])).toBe('conflict');
  });

  it('section dots name the state in words for a screen reader', () => {
    const section = A2A_CARD_EDITOR_MANIFEST.sections.find((s) => s.id === 'interfaces')!;
    const err = sectionStatus(section, {}, [{ code: 'NO_INTERFACE', severity: 'error', sourcePointer: '/supportedInterfaces', message: 'x' }]);
    expect(err.status).toBe('error');
    expect(err.label).toContain('1 error');
    expect(sectionStatus(section, {}, []).status).toBe('clean');
  });

  it('tri-state distinguishes unset from explicit false', () => {
    expect(triStateOf(undefined)).toBe('unset');
    expect(triStateOf(false)).toBe('no');
    expect(triStateOf(true)).toBe('yes');
  });
});

describe('diagnostics copy', () => {
  const d = (over: Partial<ProjectionDiagnosticV1>): ProjectionDiagnosticV1 => ({ code: 'X', severity: 'error', message: 'raw', ...over });

  it('uses the steward-facing sentence and keeps the validator message as the "why"', () => {
    const v = diagnosticView(d({ code: 'STRUCT_MISSING_FIELD', sourcePointer: '/name', message: 'name is required' }));
    expect(v.message).toBe('Agent name is required.');
    expect(v.explanation).toBe('name is required');
    expect(v.fix?.label).toBe('Go to field');
  });

  it('falls back to the validator message for an unmapped code — never a blank', () => {
    expect(diagnosticView(d({ code: 'BRAND_NEW_CODE', message: 'something specific' })).message).toBe('something specific');
  });

  it('evidenceNeeded is its own group, ordered after errors and before warnings', () => {
    const groups = groupDiagnostics([
      d({ code: 'PROVIDER_MISSING', severity: 'warning' }),
      d({ code: 'CAPABILITY_UNVERIFIED', severity: 'evidenceNeeded' }),
      d({ code: 'NO_INTERFACE', severity: 'error' }),
      d({ code: 'UNKNOWN_FIELD', severity: 'info' }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['errors', 'evidence', 'warnings', 'info']);
  });

  it('drops empty groups', () => {
    expect(groupDiagnostics([d({ severity: 'error' })]).map((g) => g.id)).toEqual(['errors']);
  });
});

describe('release diff', () => {
  const card = (over: Partial<A2AAgentCardV1> = {}): A2AAgentCardV1 => ({
    protocolVersion: '1.0',
    name: 'a',
    description: 'd',
    version: '1.2.3',
    supportedInterfaces: [{ url: 'https://x/api', protocolBinding: 'JSONRPC' }],
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
    ...over,
  });

  it('says "first release" by reporting every leaf as added when there is no previous', () => {
    expect(diffCards(null, card()).every((r) => r.kind === 'added')).toBe(true);
  });

  it('reports changed / added / removed leaves', () => {
    const rows = diffCards(card(), card({ name: 'b', iconUrl: 'https://i' }));
    expect(rows.find((r) => r.pointer === '/name')).toMatchObject({ kind: 'changed', before: '"a"', after: '"b"' });
    expect(rows.find((r) => r.pointer === '/iconUrl')).toMatchObject({ kind: 'added' });
    expect(diffCards(card({ iconUrl: 'https://i' }), card()).find((r) => r.pointer === '/iconUrl')).toMatchObject({ kind: 'removed' });
  });

  it('is empty for identical cards', () => {
    expect(diffCards(card(), card())).toEqual([]);
  });
});

describe('projection rows + impact', () => {
  const projection = (over: Partial<StoredProjection['instance']> = {}): StoredProjection => ({
    instance: {
      type: 'ProjectionInstanceV1',
      instanceId: 'inst-1',
      agent: 'eip155:84532:0xabc' as StoredProjection['instance']['agent'],
      definition: {
        id: 'ap-naming',
        digest: `sha256:${'0'.repeat(64)}`,
        target: { family: 'ap-naming', specification: 'ap-naming', version: '1', sourceDigest: null },
        adapter: { packageName: '@agenticprimitives/registry-kit', version: '1.2.0', implementationDigest: null },
      },
      configuration: {},
      configurationDigest: `sha256:${'1'.repeat(64)}`,
      state: 'published',
      since: 'now',
      desiredSources: { selectedCardDigest: `sha256:${'a'.repeat(64)}` },
      ...over,
    },
    family: 'ap-naming',
    selectedCard: { cardResourceId: 'card-1', releaseId: 'r1' },
    planIds: [],
    receiptIds: [],
  });

  it('labels the target, never the raw family', () => {
    expect(targetLabel('ap-registry')).toBe('AP Registry');
    expect(targetLabel('something-else')).toBe('something-else');
  });

  it('claims `current` only when the published digest matches the latest release', () => {
    expect(projectionRowFrom(projection(), { scopes: HUMAN, latestReleaseDigest: `sha256:${'a'.repeat(64)}` }).drift).toBe('current');
    expect(projectionRowFrom(projection(), { scopes: HUMAN, latestReleaseDigest: `sha256:${'b'.repeat(64)}` }).drift).toBe('source-stale');
  });

  it('leaves drift UNSET when the records cannot support a claim', () => {
    expect(projectionRowFrom(projection({ state: 'configured' }), { scopes: HUMAN, latestReleaseDigest: null }).drift).toBeUndefined();
    expect(projectionRowFrom(projection(), { scopes: HUMAN }).drift).toBeUndefined();
  });

  it('omits the binding row when no binding record carries a lifecycle state', () => {
    expect(projectionRowFrom(projection(), { scopes: HUMAN }).binding).toBeUndefined();
  });

  it('an empty loss list is a claim, not an omission', () => {
    expect(projectionRowFrom(projection(), { scopes: HUMAN }).losses).toEqual([]);
  });

  it('warns that a pending release will make published projections stale', () => {
    expect(projectionImpact([projection()], { latestReleaseId: 'r1', pendingNewRelease: false })[0]!.drift).toBe('current');
    expect(projectionImpact([projection()], { latestReleaseId: 'r1', pendingNewRelease: true })[0]!.drift).toBe('source-stale');
    expect(projectionImpact([projection()], { latestReleaseId: 'r2', pendingNewRelease: false })[0]!.drift).toBe('source-stale');
  });

  it('uses lead words, never the raw loss enum', () => {
    expect(lossLead('approximateMapping')).toBe('Approximate mapping');
    expect(lossLead('manualActionRequired')).toBe('Needs your attention');
  });
});

describe('card URI derivation', () => {
  const opts = { nameParent: 'impact', a2aDomain: 'impact-agent.io' };
  it('drops the naming zone and folds a typed suffix into one label', () => {
    expect(cardUriForName('vendor-payments.impact', opts)).toBe('https://vendor-payments.impact-agent.io/.well-known/agent-card.json');
    expect(cardUriForName('finance.team.impact', opts)).toBe('https://finance-team.impact-agent.io/.well-known/agent-card.json');
  });
  it('returns null for a nameless agent', () => {
    expect(cardUriForName('', opts)).toBeNull();
    expect(cardUriForName('impact', opts)).toBeNull();
  });
});

describe('compareServed — editing vs released vs served', () => {
  const D = 'sha256:' + 'ab'.repeat(32);
  const E = 'sha256:' + 'cd'.repeat(32);
  it('names the live plane when nothing is published', () => {
    const c = compareServed({ reachable: true, status: 200, source: 'live', canonicalDigest: D }, { draftDigest: D });
    expect(c.verdict.kind).toBe('live');
    expect(c.matchesDraft).toBe(true);
    expect(c.matchesRelease).toBeNull();
  });
  it('confirms a released card serving the selected release byte for byte', () => {
    const c = compareServed({ reachable: true, status: 200, source: 'released', servedDigest: D, canonicalDigest: E }, { draftDigest: E, release: { releaseId: 'r1', signedContentDigest: D } });
    expect(c.verdict.kind).toBe('released-current');
    expect(c.matchesRelease).toBe(true);
  });
  it('says so when a DIFFERENT release is live', () => {
    const c = compareServed({ reachable: true, status: 200, source: 'released', servedDigest: E }, { release: { releaseId: 'r2', signedContentDigest: D } });
    expect(c.verdict.kind).toBe('released-superseded');
    expect(c.verdict.line).toContain('r2');
    expect(c.matchesRelease).toBe(false);
  });
  it('reports unreachable and HTTP errors without claiming anything about the card', () => {
    expect(compareServed({ reachable: false, detail: 'egress failed: boom' }, {})).toMatchObject({ verdict: { kind: 'unreachable' }, matchesDraft: null });
    expect(compareServed({ reachable: true, status: 503 }, { draftDigest: D }).verdict.kind).toBe('error');
  });
});

describe('publicationVerdict — what a steward is told after publish/verify', () => {
  const uri = 'https://ncf.faithnet.io/.well-known/agent-card.json';
  it('an in-process check is reported as serving-verified, never as proof of public routing', () => {
    const v = publicationVerdict({ verificationResult: 'valid', uri, observedVia: 'serving-handler' });
    expect(v.tone).toBe('good');
    expect(v.title).toContain('returns exactly these bytes');
    expect(v.title).not.toMatch(/Live and verified/);
    expect(v.next).toContain('Live endpoint');
  });
  it('confirms a verified publication and asks for nothing', () => {
    const v = publicationVerdict({ verificationResult: 'valid', uri });
    expect(v).toMatchObject({ tone: 'good', next: null });
    expect(v.title).toContain('ncf.faithnet.io');
  });
  it('an unreachable host says the release is safe and names what an operator must fix', () => {
    const v = publicationVerdict({ verificationResult: 'unverified', uri, detail: 'HTTP 530' });
    expect(v.tone).toBe('warn');
    expect(v.title).toContain('Nothing is serving your card yet');
    expect(v.next).toMatch(/signed and stored safely/);
    expect(v.next).toContain('ncf.faithnet.io');
    expect(v.detail).toBe('HTTP 530');
    expect(publicationVerdict({ verificationResult: 'unverified', uri, detail: 'egress failed: getaddrinfo ENOTFOUND' }).title).toContain('did not answer');
  });
  it('distinguishes a 404 from an unreachable host and from a byte mismatch', () => {
    expect(publicationVerdict({ verificationResult: 'unverified', uri, detail: 'HTTP 404' }).title).toContain('not serving a card at that path');
    const mismatch = publicationVerdict({ verificationResult: 'invalid', uri, detail: 'served digest a, expected b' });
    expect(mismatch.title).toContain('different bytes');
    expect(mismatch.next).toMatch(/publish this release again/);
  });
  it('falls back to a plain wait-and-retry line, never a raw status code as the headline', () => {
    const v = publicationVerdict({ verificationResult: 'unverified', uri, detail: 'HTTP 418' });
    expect(v.title).toContain('could not confirm');
    expect(v.title).not.toContain('418');
    expect(v.detail).toBe('HTTP 418');
  });
});

describe('studioErrorSentence — service codes become something a steward can act on', () => {
  it('explains a nameless agent instead of printing agent_has_no_host', () => {
    const m = studioErrorSentence('agent_has_no_host');
    expect(m).toContain('no public name yet');
    expect(m).toContain('Naming');
    expect(studioErrorSentence('the agent has no name, so no well-known host to publish at')).toBe(m);
  });
  it('covers the other terse codes and passes anything else through unchanged', () => {
    expect(studioErrorSentence('stale_revision')).toContain('Someone else changed this draft');
    expect(studioErrorSentence('scope_not_held')).toContain('do not hold the access');
    expect(studioErrorSentence('Network request failed')).toBe('Network request failed');
    expect(studioErrorSentence('publication execute failed: userop_reverted — inner userOp reverted (no UserOperationEvent for sender=0xb2 — sendersSeen=[] tx=0xfd)')).toContain("account rejected the write");
  });
});

describe('lifecycleOrientation — one shared "where am I / what next" picture for every tab', () => {
  it('names Validate as the next action on a fresh, unvalidated draft', () => {
    const o = lifecycleOrientation({ draftState: 'draft', release: null, scopes: HUMAN });
    expect(o.current).toBe('validate');
    expect(o.actionable).toBe(true);
    expect(o.line).toContain('validate this draft');
  });
  it('names Create release once the draft validates clean', () => {
    const o = lifecycleOrientation({ draftState: 'validated', release: null, scopes: HUMAN });
    expect(o.current).toBe('create-release');
    expect(o.line).toContain('create a release');
  });
  it('tells a non-approver they are waiting, using the same duty wording gateForOp already produces', () => {
    const editorOnly = studioScopesFor({ principalKind: 'service-agent', relationship: 'steward' });
    const o = lifecycleOrientation({ draftState: 'validated', release: { state: 'approvalPending' }, scopes: editorOnly });
    expect(o.current).toBe('approve');
    expect(o.actionable).toBe(false);
    expect(o.line).toBe(gateForOp(editorOnly, 'release.approve').reason);
  });
  it('tells the approver they can act', () => {
    const o = lifecycleOrientation({ draftState: 'validated', release: { state: 'approvalPending' }, scopes: HUMAN });
    expect(o.current).toBe('approve');
    expect(o.actionable).toBe(true);
    expect(o.line).toContain('approve or reject');
  });
  it('reports published as live, not as a pending step', () => {
    const o = lifecycleOrientation({ draftState: 'validated', release: { state: 'published' }, scopes: HUMAN });
    expect(o.current).toBeNull();
    expect(o.line).toContain('Live');
  });
  it('names each terminal state instead of falling through to the generic "Live" line', () => {
    expect(lifecycleOrientation({ draftState: 'validated', release: { state: 'superseded' }, scopes: HUMAN }).line).toContain('superseded');
    expect(lifecycleOrientation({ draftState: 'validated', release: { state: 'revoked' }, scopes: HUMAN }).line).toContain('revoked');
  });
});

describe('namesAndBindingsRows — every row states what is true, then what to do about it', () => {
  const base = {
    agentName: 'vendor-payments.impact',
    hasSignedRelease: false,
    published: null,
    namingConfigured: false,
    namingDigestMatches: null,
    registryBindings: [],
    releasesHref: '/releases',
    projectionsHref: '/projections',
  } as const;

  it('collapses ownership/resolution/canonical into one confirmed line when the agent has a name', () => {
    const rows = namesAndBindingsRows(base);
    const identity = rows.find((r) => r.id === 'identity')!;
    expect(identity.state).toBe('ok');
    expect(identity.line).toContain('vendor-payments.impact');
    expect(identity.line).toContain('owns the name');
  });
  it('the nameless case explains the consequence, never a bare negative', () => {
    const identity = namesAndBindingsRows({ ...base, agentName: '' }).find((r) => r.id === 'identity')!;
    expect(identity.state).toBe('empty');
    expect(identity.line).toContain('no public name yet');
  });
  it('publication: nothing signed yet points at Releases & Audit', () => {
    const row = namesAndBindingsRows(base).find((r) => r.id === 'publication')!;
    expect(row.state).toBe('empty');
    expect(row.next).toEqual({ label: 'Go to Releases & Audit', href: '/releases' });
  });
  it('publication: a signed-but-unpublished release still names the exact next step', () => {
    const row = namesAndBindingsRows({ ...base, hasSignedRelease: true }).find((r) => r.id === 'publication')!;
    expect(row.state).toBe('empty');
    expect(row.line).toContain('signed release');
    expect(row.next?.label).toBe('Publish it from Releases & Audit');
  });
  it('publication: published but not linked to the name points at Projections', () => {
    const row = namesAndBindingsRows({ ...base, published: { releaseNumber: 4, uri: 'https://x/.well-known/agent-card.json' } }).find((r) => r.id === 'publication')!;
    expect(row.state).toBe('empty');
    expect(row.line).toContain('release 4');
    expect(row.next?.label).toBe('Link it from Projections');
  });
  it('publication: linked and matching is the healthy, quiet state', () => {
    const row = namesAndBindingsRows({ ...base, published: { releaseNumber: 4, uri: null }, namingConfigured: true, namingDigestMatches: true }).find((r) => r.id === 'publication')!;
    expect(row.state).toBe('ok');
    expect(row.next).toBeUndefined();
  });
  it('publication: linked but stale still says exactly what to do', () => {
    const row = namesAndBindingsRows({ ...base, published: { releaseNumber: 4, uri: null }, namingConfigured: true, namingDigestMatches: false }).find((r) => r.id === 'publication')!;
    expect(row.state).toBe('stale');
    expect(row.next?.label).toBe('Update in Projections');
  });
  it('registry: none configured points at Projections', () => {
    const row = namesAndBindingsRows(base).find((r) => r.id === 'registry')!;
    expect(row.state).toBe('empty');
    expect(row.next?.href).toBe('/projections');
  });
  it('registry: all active bindings read as ok with a count, no dangling next', () => {
    const row = namesAndBindingsRows({ ...base, registryBindings: [{ lifecycle: { state: 'active', since: 't' } }] }).find((r) => r.id === 'registry')!;
    expect(row.state).toBe('ok');
    expect(row.line).toContain('1 registry');
  });
  it('registry: a revoked binding among others reads as mismatch, not ok', () => {
    const row = namesAndBindingsRows({
      ...base,
      registryBindings: [{ lifecycle: { state: 'active', since: 't' } }, { lifecycle: { state: 'revoked', since: 't' } }],
    }).find((r) => r.id === 'registry')!;
    expect(row.state).toBe('mismatch');
  });
  it('registry: pendingVerification reads as stale, not ok', () => {
    const row = namesAndBindingsRows({ ...base, registryBindings: [{ lifecycle: { state: 'pendingVerification', since: 't' } }] }).find((r) => r.id === 'registry')!;
    expect(row.state).toBe('stale');
  });
});

describe('cardUriForName — one DNS label (spec 346 §5)', () => {
  const opts = { nameParent: 'me', a2aDomain: 'faithnet.io' };
  it('hyphenates the type into the label and drops a person root', () => {
    expect(cardUriForName('fort-morgan-household.church', opts)).toBe('https://fort-morgan-household-church.faithnet.io/.well-known/agent-card.json');
    expect(cardUriForName('alice.me', opts)).toBe('https://alice.faithnet.io/.well-known/agent-card.json');
    expect(cardUriForName('', opts)).toBeNull();
  });
});
