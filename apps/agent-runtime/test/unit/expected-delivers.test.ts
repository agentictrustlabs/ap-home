// Spec 418 A2 — what the outcome check asks the answer to have delivered: the intermediate step's class and the terminal
// skill's products, never a PART of a whole the same skill produces (`within`, from an ontology object property).
import { describe, expect, it } from 'vitest';
import { expectedDeliversOf } from '../../src/harness-run.js';

const C = 'https://skills.demo/cil-commons#';
const skills = [
  { id: 'assess', produces: [{ iri: `${C}DeploymentInventory`, label: 'Deployment Inventory' }] },
  { id: 'incident', produces: [{ iri: `${C}IncidentPlaybook`, label: 'Incident Playbook' }, { iri: `${C}PlaybookStep`, label: 'Playbook Step', within: `${C}IncidentPlaybook` }, { iri: `${C}PostMortemTemplate`, label: 'Post-Mortem Template', within: `${C}IncidentPlaybook` }] },
];

describe('expectedDeliversOf', () => {
  it('asks for the intermediate artifact and the whole, not its parts', () => {
    expect(expectedDeliversOf([{ tool: 'assess', for: `${C}DeploymentInventory` }, { tool: 'incident' }], skills).map((x) => x.iri)).toEqual([`${C}DeploymentInventory`, `${C}IncidentPlaybook`]);
    expect(expectedDeliversOf([{ tool: 'assess', for: `${C}DeploymentInventory` }, { tool: 'incident' }], skills).map((x) => !!x.required)).toEqual([true, false]);
  });
  it('keeps a part whose whole the skill does not produce', () => {
    const lone = [{ id: 'x', produces: [{ iri: `${C}PlaybookStep`, label: 'Playbook Step', within: `${C}IncidentPlaybook` }] }];
    expect(expectedDeliversOf([{ tool: 'x' }], lone).map((x) => x.iri)).toEqual([`${C}PlaybookStep`]);
  });
  // 2026-10-02 — the drafter's LOI | proposal: 51 of 68 grant runs (chain panels 1–4) lost ~⅓ for the one never written.
  it('carries a terminal product\'s alternative group; an intermediate is required, never "one of"', () => {
    const drafter = [
      { id: 'track', produces: [{ iri: `${C}PipelineEntry`, label: 'Pipeline Entry', alternative: 'stray' }] },
      { id: 'draft', produces: [{ iri: `${C}LetterOfInquiry`, label: 'Letter of Inquiry', alternative: 'drafted-application' }, { iri: `${C}GrantProposal`, label: 'Grant Proposal', alternative: 'drafted-application' }, { iri: `${C}ClaimPlaceholder`, label: 'Claim Placeholder' }] },
    ];
    expect(expectedDeliversOf([{ tool: 'track', for: `${C}PipelineEntry` }, { tool: 'draft' }], drafter)).toEqual([
      { iri: `${C}PipelineEntry`, label: 'Pipeline Entry', required: true },
      { iri: `${C}LetterOfInquiry`, label: 'Letter of Inquiry', alternative: 'drafted-application' },
      { iri: `${C}GrantProposal`, label: 'Grant Proposal', alternative: 'drafted-application' },
      { iri: `${C}ClaimPlaceholder`, label: 'Claim Placeholder' },
    ]);
  });
});

// 2026-10-14 (W2) — the GOLD plan's expectation: the expert's plan decides the classes, not the agent's.
import { expectedDeliversOfGold } from '../../src/harness-run.js';
describe('expectedDeliversOfGold', () => {
  const drafter = [
    { id: 'cic.grants.pipeline', produces: [{ iri: `${C}GrantPipeline`, label: 'Grant Pipeline' }, { iri: `${C}PipelineEntry`, label: 'Pipeline Entry' }] },
    { id: 'cic.grants.draft', produces: [{ iri: `${C}LetterOfInquiry`, label: 'Letter of Inquiry', alternative: 'drafted-application' }, { iri: `${C}GrantProposal`, label: 'Grant Proposal', alternative: 'drafted-application' }, { iri: `${C}ClaimPlaceholder`, label: 'Claim Placeholder' }] },
    { id: 'cic.stakeholder.update', produces: [{ iri: `${C}StakeholderBriefing`, label: 'Stakeholder Briefing' }, { iri: `${C}AudienceVersion`, label: 'Audience Version', within: `${C}StakeholderBriefing` }] },
  ];
  it('a chain: every intermediate product required, the terminal products candidates with their alternative group', () => {
    const r = expectedDeliversOfGold({ plan: ['cic.grants.pipeline', 'cic.grants.draft'] }, drafter);
    expect(r.unknown).toEqual([]);
    expect(r.expected).toEqual([
      { iri: `${C}GrantPipeline`, label: 'Grant Pipeline', required: true }, { iri: `${C}PipelineEntry`, label: 'Pipeline Entry', required: true },
      { iri: `${C}LetterOfInquiry`, label: 'Letter of Inquiry', alternative: 'drafted-application' }, { iri: `${C}GrantProposal`, label: 'Grant Proposal', alternative: 'drafted-application' }, { iri: `${C}ClaimPlaceholder`, label: 'Claim Placeholder' },
    ]);
  });
  it('a missing input is an expectation to NAME it; a clarify case expects the ask-which; a part of a whole is left out; an unknown capability is named', () => {
    const r = expectedDeliversOfGold({ plan: ['cic.stakeholder.update', 'cic.nope'], missing: [`${C}FactBase`], behaviour: 'clarify' }, drafter, [{ iri: `${C}FactBase`, label: 'Fact Base', terms: ['fact base'] }]);
    expect(r.unknown).toEqual(['cic.nope']);
    expect(r.expected.map((x) => [x.iri, x.kind ?? 'delivered', !!x.required])).toEqual([
      [`${C}StakeholderBriefing`, 'delivered', true], [`${C}FactBase`, 'named-missing', true], ['urn:ap:outcome:asked-which', 'asked-which', true],
    ]);
  });
});

// 2026-10-14 (W0) — a domain record effect writes the emitted record to the asker's vault; a class with no record is a
// failed effect by name; every other effect goes to the base sink.
import { withDomainRecordEffects } from '../../src/harness-run.js';
describe('withDomainRecordEffects', () => {
  const ASKER = '0x' + '11'.repeat(20);
  const e = (effect: unknown, result: unknown) => ({ runRef: 'run-1', stepRef: 's0', effect, step: {}, result, receipt: {} });
  it('writes the emitted record, typed and stamped, under the record-type rule; hands a payment effect to the base sink', async () => {
    const written: Array<[string, string, unknown]> = []; const base: unknown[] = []; const emitted: string[] = [];
    const sink = withDomainRecordEffects({ async discharge(x) { base.push(x.effect); } }, { recipient: ASKER, recordTypeOf: (c) => `cil-commons.${c.split('#').pop()!.toLowerCase()}`, write: async (s, t, r) => { written.push([s, t, r]); return { ok: true }; }, onWritten: (c) => emitted.push(c) });
    await sink.discharge(e({ on: 'success', produces: `${C}IncidentPlaybook`, surface: ['record'] }, { records: [{ class: `${C}IncidentPlaybook`, record: { label: 'Playbook', playbookSeverity: 'severe' } }], skill: { id: 'skill:cil-commons/x', digest: 'sha256:aa' } }));
    expect(written).toHaveLength(1);
    expect(written[0]![0]).toBe(ASKER); expect(written[0]![1]).toBe('cil-commons.incidentplaybook');
    expect(written[0]![2]).toMatchObject({ type: 'ap.domain-record.v1', class: `${C}IncidentPlaybook`, runRef: 'run-1', skill: 'skill:cil-commons/x', label: 'Playbook', playbookSeverity: 'severe' });
    expect(emitted).toEqual([`${C}IncidentPlaybook`]);
    await sink.discharge(e({ on: 'success', produces: 'PaymentReceipt' }, {}));
    expect(base).toHaveLength(1);
  });
  it('a class the answer emitted no record for, or a write that failed, is a thrown (failed) effect naming the class', async () => {
    const sink = withDomainRecordEffects({ async discharge() {} }, { recipient: ASKER, recordTypeOf: () => 't', write: async () => ({ ok: false, error: 'vault 503' }) });
    await expect(sink.discharge(e({ produces: `${C}IncidentPlaybook` }, { records: [], recordError: 'the record block is not JSON' }))).rejects.toThrow('no IncidentPlaybook record was emitted with the answer (the record block is not JSON)');
    await expect(sink.discharge(e({ produces: `${C}IncidentPlaybook` }, { records: [{ class: `${C}IncidentPlaybook`, record: {} }] }))).rejects.toThrow('vault 503');
  });
});
