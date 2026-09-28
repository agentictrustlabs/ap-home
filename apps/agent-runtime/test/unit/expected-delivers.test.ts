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
});
