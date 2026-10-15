/**
 * THE STATE CHECK READS THE RECORD CONTRACT, not a stricter one (2026-10-15). The first run with records in the vault
 * (ol-fh7-record-body-2) failed 15 of 16 state checks on two rules the contract never set: a class-typed field had to be an
 * IRI although the record instruction and the bodies say "the artifact's label as a string", and a drafter's Letter of
 * Inquiry left "GrantProposal absent" although the two are declared alternatives. A grader stricter than the contract
 * reads every right answer as wrong, and nothing in the number says which side is broken.
 */
import { describe, it, expect } from 'vitest';
import { stateCheckOf, validateRecord, type DomainShapeV1 } from '../src/state-check.js';

const NS = 'https://skills.demo/cil-commons#';
const playbook: DomainShapeV1 = { class: `${NS}IncidentPlaybook`, label: 'Incident Playbook', fields: [
  { name: 'label', path: 'rdfs:label', minCount: 1 },
  { name: 'playbookFor', path: `${NS}playbookFor`, minCount: 1, class: `${NS}DeploymentInventory` },
  { name: 'playbookClass', path: `${NS}playbookClass`, minCount: 1, allowed: ['privacy-leak', 'biased-output'] },
] };
const loi: DomainShapeV1 = { class: `${NS}LetterOfInquiry`, label: 'Letter of Inquiry', fields: [{ name: 'pursuesEntry', path: `${NS}pursuesEntry`, minCount: 1, class: `${NS}PipelineEntry` }] };
const proposal: DomainShapeV1 = { class: `${NS}GrantProposal`, label: 'Grant Proposal', fields: [{ name: 'pursuesEntry', path: `${NS}pursuesEntry`, minCount: 1, class: `${NS}PipelineEntry` }] };

describe('a reference by label is a reference', () => {
  it('accepts the referenced artifact\'s label, an IRI, or an object; refuses a blank', () => {
    expect(validateRecord({ label: 'Runbook', playbookFor: 'Deployment Inventory — Donor Chatbot', playbookClass: 'privacy-leak' }, playbook).valid).toBe(true);
    expect(validateRecord({ label: 'Runbook', playbookFor: `${NS}inv-1`, playbookClass: 'privacy-leak' }, playbook).valid).toBe(true);
    expect(validateRecord({ label: 'Runbook', playbookFor: { label: 'inventory' }, playbookClass: 'privacy-leak' }, playbook).valid).toBe(true);
    const blank = validateRecord({ label: 'Runbook', playbookFor: '   ', playbookClass: 'privacy-leak' }, playbook);
    expect(blank.valid).toBe(false); expect(blank.errors[0]).toMatch(/must reference a DeploymentInventory/);
  });
  it('still holds a controlled value to its notations', () => {
    expect(validateRecord({ label: 'Runbook', playbookFor: 'inv', playbookClass: 'sev-9' }, playbook).errors[0]).toMatch(/not one of/);
  });
});

describe('an alternative group is satisfied by any one member', () => {
  const expected = [{ iri: `${NS}LetterOfInquiry`, alternative: 'draft' }, { iri: `${NS}GrantProposal`, alternative: 'draft' }];
  it('passes with a valid LOI and no proposal, and says what satisfied the group', () => {
    const sc = stateCheckOf(expected, { [`${NS}LetterOfInquiry`]: { pursuesEntry: 'Pipeline Entry — Hearth Fund' } }, [loi, proposal]);
    expect(sc.pass).toBe(true);
    expect(sc.classes[`${NS}GrantProposal`]).toMatchObject({ exists: false, valid: true, satisfiedBy: `${NS}LetterOfInquiry` });
  });
  it('fails when no member is there, and when the only member present is invalid', () => {
    expect(stateCheckOf(expected, {}, [loi, proposal]).pass).toBe(false);
    expect(stateCheckOf(expected, { [`${NS}LetterOfInquiry`]: { label: 'LOI' } }, [loi, proposal]).pass).toBe(false);
  });
  it('a class outside any group is still required on its own', () => {
    const sc = stateCheckOf([...expected, { iri: `${NS}IncidentPlaybook` }], { [`${NS}LetterOfInquiry`]: { pursuesEntry: 'x' } }, [loi, proposal, playbook]);
    expect(sc.pass).toBe(false);
  });
});
