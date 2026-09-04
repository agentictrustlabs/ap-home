import { describe, it, expect } from 'vitest';
import { askVocabulary, askDescriptors, scopedActionTools, surfaceCanRender, CAPABILITY_CEREMONIES } from '../src/harness-run.js';

describe('the published Ask vocabulary (spec 353 S2)', () => {
  it('names exactly what the planner can pick — no more, no less', () => {
    // The drift this test exists to prevent: a vocabulary advertising a capability the planner cannot
    // choose, or a planner offering one the vocabulary never named. Both lists are separately plausible.
    const offered = scopedActionTools().map((t) => t.capability?.id ?? t.id).filter((id) => id !== 'ask.unsupported');
    const published = askVocabulary().map((c) => c.id);
    expect(published.sort()).toEqual(offered.sort());
  });

  it('carries the ceremonies a capability may ASK FOR, not merely those its risk implies', () => {
    const team = askVocabulary().find((c) => c.id === 'organization.team.create')!;
    // medium risk — the risk floor alone would NOT include a signature
    expect(team.riskTier).toBe('medium');
    expect(team.ceremonies).toContain('signature');
    // and the floor is still there
    expect(team.ceremonies).toEqual(expect.arrayContaining(['data', 'confirmation']));
  });

  it('agrees with the offer-time filter, so a declared scope and the published list cannot disagree', () => {
    const renders = ['data', 'confirmation']; // a surface that cannot sign
    for (const cap of askVocabulary()) {
      const canRenderAll = cap.ceremonies.every((ceremony) => renders.includes(ceremony));
      expect(surfaceCanRender(cap.id, renders)).toBe(canRenderAll);
    }
  });

  it('every capability with a declared ceremony survives the projection', () => {
    const published = new Set(askVocabulary().map((c) => c.id));
    for (const id of Object.keys(CAPABILITY_CEREMONIES)) expect(published.has(id)).toBe(true);
  });

  it('descriptors declare an idempotency class — an authority-bearing step is never blind-retryable', () => {
    for (const d of askDescriptors()) expect(d.operations.idempotency).toBe('key-required');
  });
});
