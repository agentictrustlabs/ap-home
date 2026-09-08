import { describe, expect, it } from 'vitest';
import { progressLine, toolWords } from '../src/harness-progress.js';
import type { ToolSpec } from '@agenticprimitives/orchestration';

// Spec 370 P2 — one sentence per loop event, in the agent's words, never a tool id.
const tools: ToolSpec[] = [
  { id: 'org.members', description: 'the roster' },
  { id: 'organization.create', description: 'charter an organization', capability: { id: 'organization.create', action: 'create', resourceArg: 'parent' }, risk: 'medium' },
];
const words = (id: string) => ({ 'organization.create': 'create organizations' } as Record<string, string>)[id];

describe('the run speaks as it goes', () => {
  it('names a step by the capability phrase, and a read by its description', () => {
    expect(toolWords(tools[1], words)).toBe('create organizations');
    expect(toolWords(tools[0], words)).toBe('the roster');
    expect(progressLine({ type: 'StepProposed', runRef: 'r', stepRef: 's1', toolId: 'organization.create', risk: 'medium' }, tools, words)?.said).toBe('Checking your authority to create organizations…');
    expect(progressLine({ type: 'StepProposed', runRef: 'r', stepRef: 's0', toolId: 'org.members', risk: 'informational' }, tools, words)?.said).toBe('Reading the roster…');
    expect(progressLine({ type: 'ToolInvoked', runRef: 'r', stepRef: 's1', toolId: 'organization.create', ok: true }, tools, words)?.said).toBe('Create organizations — done.');
    expect(progressLine({ type: 'StepReplayed', runRef: 'r', stepRef: 's0', toolId: 'org.members' }, tools, words)?.said).toBe('The roster: already done.');
    expect(progressLine({ type: 'MandateChecked', runRef: 'r', stepRef: 's1', decision: 'allow', afterApproval: false }, tools, words)?.said).toBe('Authority confirmed — going ahead.');
    expect(progressLine({ type: 'MandateChecked', runRef: 'r', stepRef: 's1', decision: 'deny', afterApproval: false }, tools, words)).toBeNull(); // MandateDenied says it
    expect(progressLine({ type: 'RunCompleted', runRef: 'r' }, tools, words)).toMatchObject({ said: 'Done.', terminal: true });
    expect(progressLine({ type: 'RunFailed', runRef: 'r', error: 'intent-mismatch: the mandate is bound to 0x…' }, tools, words)?.said).toBe('That did not go through: intent-mismatch.');
    expect(progressLine({ type: 'RunStarted', runRef: 'r', intent: { goal: 'x' }, presentedRef: null }, tools, words)).toBeNull();
  });
});
