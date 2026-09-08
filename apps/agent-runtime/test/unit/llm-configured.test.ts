// A deployment configured to plan with a model must never plan without one (ADR-0013: no silent fallback).
// Spec 375: a deployment OFFERS an ordered allowlist; a turn may name one; nothing swaps.
import { describe, it, expect } from 'vitest';
import { llmConfigured, selectPlanner, selectComposer, llmAllowlist, defaultProvider, resolveProvider, availableModels, modelFor, GROQ_DEFAULTS } from '../../src/orchestration.js';
import { structuredCallFor } from '../../src/context-wiring.js';

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
    expect(structuredCallFor({} as never)).toBeUndefined();
  });
  it('both set ⇒ the model plans', () => {
    expect(llmConfigured({ ORCHESTRATION_LLM: 'anthropic', ANTHROPIC_API_KEY: 'k' } as never)).toBe(true);
    expect(selectPlanner({ ORCHESTRATION_LLM: 'anthropic', ANTHROPIC_API_KEY: 'k' } as never)).toMatchObject({ kind: 'anthropic', model: 'claude-sonnet-4-6' });
  });
});

describe('the offer (spec 375)', () => {
  const both = { ORCHESTRATION_LLM: 'anthropic,groq', ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' } as never;

  it('parses an ordered allowlist, trimmed and case-insensitive; the first is the default', () => {
    expect(llmAllowlist({ ORCHESTRATION_LLM: 'anthropic, Groq ' } as never)).toEqual(['anthropic', 'groq']);
    expect(defaultProvider(both)).toBe('anthropic');
    expect(defaultProvider({ ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g' } as never)).toBe('groq');
    expect(defaultProvider({} as never)).toBeNull();
  });
  it('an unknown provider name in the allowlist THROWS — a typo must not silently drop a model', () => {
    expect(() => llmAllowlist({ ORCHESTRATION_LLM: 'anthropic,bogus' } as never)).toThrow(/unknown provider "bogus"/);
  });
  it('a named provider runs on that provider — planner, composer and the structured call alike', () => {
    expect(selectPlanner(both, { provider: 'groq' })).toMatchObject({ kind: 'groq', model: GROQ_DEFAULTS.model });
    expect(selectPlanner(both).kind).toBe('anthropic');
    expect(selectComposer(both, { provider: 'groq' })).not.toBeNull();
    expect(typeof structuredCallFor(both, 'groq')).toBe('function');
    expect(modelFor({ ...(both as object), ORCHESTRATION_GROQ_MODEL: 'openai/gpt-oss-20b' } as never, 'groq')).toBe('openai/gpt-oss-20b');
  });
  it('a request for a provider that is not offered is refused with the offer named — never the default', () => {
    expect(resolveProvider(both, 'workers-ai')).toEqual({ ok: false, error: expect.stringMatching(/"workers-ai" is not offered.*offered: anthropic, groq/) });
    expect(resolveProvider({ ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g' } as never, 'anthropic')).toMatchObject({ ok: false });
    expect(resolveProvider(both, undefined)).toEqual({ ok: true, provider: 'anthropic' });
    expect(resolveProvider(both, '')).toEqual({ ok: true, provider: 'anthropic' });
    expect(resolveProvider(both, 'GROQ')).toEqual({ ok: true, provider: 'groq' });
  });
  it('a provider that is listed and keyless THROWS when named, and is omitted from the offer', () => {
    const keyless = { ORCHESTRATION_LLM: 'anthropic,groq', ANTHROPIC_API_KEY: 'a' } as never;
    expect(() => resolveProvider(keyless, 'groq')).toThrow(/GROQ_API_KEY is not set/);
    expect(() => selectPlanner(keyless, { provider: 'groq' })).toThrow(/GROQ_API_KEY is not set/);
    expect(availableModels(keyless).map((m) => m.id)).toEqual(['anthropic']);
    // the default still works: the keyless entry is not the default
    expect(llmConfigured(keyless)).toBe(true);
  });
  it('groq alone is a complete configuration', () => {
    const groqOnly = { ORCHESTRATION_LLM: 'groq', GROQ_API_KEY: 'g' } as never;
    expect(llmConfigured(groqOnly)).toBe(true);
    expect(selectPlanner(groqOnly).kind).toBe('groq');
    expect(selectComposer(groqOnly)).not.toBeNull();
  });
  it('the offer names each model, marks the free one, and exactly one default', () => {
    const offer = availableModels(both);
    expect(offer).toEqual([
      { id: 'anthropic', label: 'Claude (Anthropic)', model: 'claude-sonnet-4-6', free: false, default: true },
      { id: 'groq', label: 'GPT-OSS 120B (Groq, free)', model: 'openai/gpt-oss-120b', free: true, default: false },
    ]);
    expect(offer.filter((m) => m.default)).toHaveLength(1);
    expect(availableModels({} as never)).toEqual([]);
  });
});
