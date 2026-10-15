// 2026-10-14 (W3/W5) — the outcome is state: a delivered record validates against its shape; the required fields decide;
// a score with no evidence edge is the groundedness failure, named.
import { describe, expect, it } from 'vitest';
import { recordTypeOfClass, validateRecord, stateCheckOf, fieldsOfShape, type DomainShapeV1 } from '../../src/state-check.js';

const C = 'https://skills.demo/cil-commons#';
const scorecard: DomainShapeV1 = { class: `${C}GovernanceScorecard`, label: 'Governance Scorecard', fields: [
  { name: 'label', path: 'rdfs:label', minCount: 1 }, { name: 'resultOf', path: `${C}resultOf`, minCount: 1, maxCount: 1, class: `${C}GovernanceAssessment` }, { name: 'scorecardDatum', path: `${C}scorecardDatum`, minCount: 1, class: `${C}DimensionScore` },
] };
const score: DomainShapeV1 = { class: `${C}DimensionScore`, label: 'Dimension Score', fields: [
  { name: 'label', path: 'rdfs:label', minCount: 1 }, { name: 'scoredDimension', path: `${C}scoredDimension`, minCount: 1, maxCount: 1, vocabulary: `${C}GovernanceDimension`, allowed: ['human-oversight', 'incident-readiness'] },
  { name: 'scoredLevel', path: `${C}scoredLevel`, minCount: 1, maxCount: 1, allowed: ['0', '1', '2', '3', '4'] }, { name: 'supportedBy', path: `${C}supportedBy`, minCount: 1, class: `${C}CitedEvidence` }, { name: 'note', path: `${C}note` },
] };

describe('recordTypeOfClass — one rule for the writer and the reader', () => {
  it('uses the domain mapping when there is one, else namespace.kebab-class', () => {
    expect(recordTypeOfClass(`${C}IncidentPlaybook`)).toBe('cil-commons.incident-playbook');
    expect(recordTypeOfClass(`${C}GovernanceScorecard`, [{ recordType: 'cil.scorecard', class: `${C}GovernanceScorecard` }])).toBe('cil.scorecard');
    expect(recordTypeOfClass('https://skills.demo/heart-coach/CarePlan')).toBe('heart-coach.care-plan');
  });
});

describe('validateRecord', () => {
  it('a scorecard missing its scores fails with the field named; a complete one passes', () => {
    expect(validateRecord({ label: 'Harbor Table scorecard', resultOf: 'urn:assess:1' }, scorecard)).toEqual({ valid: false, errors: ['missing "scorecardDatum"'], uncited: 0 });
    expect(validateRecord({ label: 'x', resultOf: 'urn:assess:1', scorecardDatum: ['urn:score:1'] }, scorecard).valid).toBe(true);
  });
  it('W5 — a score that cites nothing is uncited; a value outside the vocabulary is named; a label is a reference, a blank is not', () => {
    const r = validateRecord({ label: 'Incident readiness', scoredDimension: 'incident-readiness', scoredLevel: '7', supportedBy: 'staff said so' }, score);
    expect(r.valid).toBe(false);
    // 2026-10-15 — a LABEL is a reference (the record contract names parts by label), so "staff said so" passes as the cited
    // evidence's label; only a blank reference fails. The vocabulary rule still holds.
    expect(r.errors).toEqual(['"scoredLevel"="7" is not one of 0, 1, 2, 3, 4']);
    expect(validateRecord({ label: 'x', scoredDimension: 'human-oversight', scoredLevel: '2', supportedBy: '  ' }, score).errors).toEqual(['"supportedBy" must reference a CitedEvidence (an IRI or its label)']);
    const un = validateRecord({ label: 'Incident readiness', scoredDimension: 'incident-readiness', scoredLevel: '1' }, score);
    expect(un).toEqual({ valid: false, errors: ['missing "supportedBy"'], uncited: 1 });
    expect(validateRecord({ label: 'x', scoredDimension: 'human-oversight', scoredLevel: '2', supportedBy: { label: 'interview, August' } }, score).valid).toBe(true);
  });
});

describe('stateCheckOf', () => {
  it('per expected class: exists · valid · errors; pass only when every class exists and validates; an unshaped class is checked for existence and said', () => {
    const r = stateCheckOf([{ iri: `${C}GovernanceScorecard` }, { iri: `${C}DimensionScore` }, { iri: `${C}GapRoadmap` }], {
      [`${C}GovernanceScorecard`]: { label: 'x', resultOf: 'urn:a', scorecardDatum: ['urn:s'] },
      [`${C}DimensionScore`]: { label: 'x', scoredDimension: 'human-oversight', scoredLevel: '2' },
    }, [scorecard, score]);
    expect(r.pass).toBe(false);
    expect(r.classes[`${C}GovernanceScorecard`]).toEqual({ exists: true, valid: true, errors: [] });
    expect(r.classes[`${C}DimensionScore`]).toEqual({ exists: true, valid: false, errors: ['missing "supportedBy"'], uncited: 1 });
    expect(r.classes[`${C}GapRoadmap`]).toEqual({ exists: false, valid: false, errors: ['no record'] });
    expect(r.unshaped).toEqual([`${C}GapRoadmap`]);
    expect(fieldsOfShape(score)).toEqual({ required: ['scoredDimension', 'scoredLevel', 'supportedBy'], quality: ['note'] });
  });
});
