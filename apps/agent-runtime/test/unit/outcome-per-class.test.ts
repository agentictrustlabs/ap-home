// 2026-10-14 (W4) — one judge call per class; unknown is cantTell, counted and out of the denominator.
import { describe, expect, it } from 'vitest';
import { judgeOutcomePerClass, outcomeQuestionOf } from '../../src/outcome-per-class.js';
import type { StructuredCallLike } from '@agenticprimitives/orchestration';

const C = 'https://skills.demo/cil-commons#';
function fake(table: (text: string, id: string) => Array<{ outcome: string; p: number }>): StructuredCallLike & { calls: string[] } {
  const calls: string[] = [];
  const call = (async ({ system, messages, tool }) => {
    const text = `${system}\n${messages.map((m) => m.content).join('\n')}`; calls.push(text);
    const ids = Object.keys((tool.input_schema as { properties: Record<string, unknown> }).properties);
    return Object.fromEntries(ids.map((id) => [id, table(text, id)]));
  }) as StructuredCallLike & { calls: string[] };
  call.calls = calls; return call;
}
describe('judgeOutcomePerClass', () => {
  it('one call per class plus one for the request; the question carries the comment and required fields; unknown leaves the denominator', async () => {
    const call = fake((text, id) => id === 'd'
      ? (text.includes('Deployment Inventory') ? [{ outcome: 'delivered', p: 0.9 }, { outcome: 'missing', p: 0.1 }] : text.includes('Incident Playbook') ? [{ outcome: 'n/a', p: 0.9 }] : [{ outcome: 'missing', p: 0.8 }, { outcome: 'delivered', p: 0.2 }])
      : [{ outcome: 'true', p: 0.9 }, { outcome: 'false', p: 0.1 }]);
    const r = await judgeOutcomePerClass({ request: 'get us ready', answer: 'an answer', expected: [
      { iri: `${C}DeploymentInventory`, label: 'Deployment Inventory', required: true },
      { iri: `${C}IncidentPlaybook`, label: 'Incident Playbook', comment: 'The playbook for when an AI deployment causes harm.', requiredFields: ['playbookFor', 'playbookSeverity'] },
      { iri: `${C}FactBase`, label: 'Fact Base', kind: 'named-missing' },
    ] }, call);
    expect(r.calls).toBe(4);
    expect(call.calls.some((t) => t.includes('A complete one has: playbookFor, playbookSeverity.'))).toBe(true);
    expect(r.verdicts).toEqual({ [`${C}DeploymentInventory`]: 'delivered', [`${C}IncidentPlaybook`]: 'unknown', [`${C}FactBase`]: 'missing' });
    expect(r.cantTell).toBe(1); expect(r.counted).toBe(2);
    expect(r.score).toBeCloseTo((0.9 + 0.2) / 2, 4);
    expect(outcomeQuestionOf({ iri: 'x', label: 'Fact Base', kind: 'named-missing' })).toContain('NAMES the Fact Base as missing');
  });
});
