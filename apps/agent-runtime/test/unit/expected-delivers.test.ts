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
