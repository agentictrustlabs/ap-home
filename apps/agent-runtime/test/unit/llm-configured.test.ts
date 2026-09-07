// A deployment configured to plan with a model must never plan without one (ADR-0013: no silent fallback).
import { describe, it, expect } from 'vitest';
import { llmConfigured, selectPlanner, selectComposer } from '../../src/orchestration.js';

describe('llmConfigured', () => {
  it('ORCHESTRATION_LLM=anthropic without a key THROWS — never the rule-based planner or a template', () => {
    expect(() => llmConfigured({ ORCHESTRATION_LLM: 'anthropic' } as never)).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => selectPlanner({ ORCHESTRATION_LLM: 'anthropic' } as never)).toThrow(/no rule-based fallback/);
    expect(() => selectComposer({ ORCHESTRATION_LLM: 'anthropic' } as never)).toThrow();
  });
  it('no model configured is a CONFIGURATION, not a fallback: deterministic paths run', () => {
    expect(llmConfigured({} as never)).toBe(false);
    expect(selectPlanner({} as never).kind).toBe('rule-based');
    expect(selectComposer({} as never)).toBeNull();
  });
  it('both set ⇒ the model plans', () => {
    expect(llmConfigured({ ORCHESTRATION_LLM: 'anthropic', ANTHROPIC_API_KEY: 'k' } as never)).toBe(true);
    expect(selectPlanner({ ORCHESTRATION_LLM: 'anthropic', ANTHROPIC_API_KEY: 'k' } as never).kind).toBe('anthropic');
  });
});
