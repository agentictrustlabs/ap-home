import {describe,it,expect} from 'vitest';
import {playbookBehind} from './playbook-behind';
describe('playbook update diagnosis',()=>{
 it('recognizes both runtime generations without mislabelling an authority denial',()=>{
  expect(playbookBehind('unknown_tool: plan selected a tool not exposed by this agent: person.friend.list')).toEqual({toolId:'person.friend.list'});
  expect(playbookBehind('plan_refused: step 1 names "person.friend.add", which this agent does not offer — choose among: other')).toEqual({toolId:'person.friend.add'});
  expect(playbookBehind('the authority does not cover this')).toBeNull();
 });
});
