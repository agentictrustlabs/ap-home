import { describe, it, expect } from 'vitest';
import { classifyProviderFailure, providerFailureNotice, PROVIDER_BILLING_URL } from '../src/provider-outage.js';

// The exact string the estate produced on 2026-09-20, when every Ask silently failed.
const XAI_403 =
  'planner_failed: openai-compat chat.completions.create failed (HTTP 403): {"code":"permission-denied","error":"Your team 1fae4ce5-11f9-413b-a3e6-94bfc6b2cd62 has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';

describe('a model provider that is out of credit is told to the person, with where to fix it', () => {
  it('classifies xAI "used all available credits" as exhausted, with the provider console', () => {
    const f = classifyProviderFailure('xai', XAI_403);
    expect(f.kind).toBe('exhausted');
    expect(f.provider).toBe('xai');
    expect(f.status).toBe(403);
    expect(f.url).toBe(PROVIDER_BILLING_URL.xai);
    expect(f.detail).toContain('used all available credits');
    expect(f.detail).not.toContain('openai-compat'); // the adapter's prefix is ours, not the provider's words
    expect(f.detail.startsWith('Your team ')).toBe(true); // the sentence, not the JSON envelope
    expect(classifyProviderFailure('openai', 'x failed (HTTP 429): {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}').detail).toBe('You exceeded your current quota');
  });

  it('classifies Anthropic "credit balance is too low" (HTTP 400) and OpenAI insufficient_quota (429) as exhausted', () => {
    expect(classifyProviderFailure('anthropic', 'anthropic messages.create failed (HTTP 400): Your credit balance is too low to access the Anthropic API.').kind).toBe('exhausted');
    expect(classifyProviderFailure('openai', 'openai-compat chat.completions.create failed (HTTP 429): {"error":{"code":"insufficient_quota"}}').kind).toBe('exhausted');
  });

  it('keeps a per-minute 429 apart from an empty account', () => {
    const f = classifyProviderFailure('groq', 'openai-compat chat.completions.create failed (HTTP 429, retry after 12s): Rate limit reached for model, tokens per minute (TPM)');
    expect(f.kind).toBe('rate-limited');
    expect(f.status).toBe(429);
  });

  it('leaves a failure it cannot attribute to the account audit-only (no notice)', () => {
    const f = classifyProviderFailure('gemini', 'planner_failed: openai-compat chat.completions.create failed (HTTP 500): internal');
    expect(f.kind).toBe('other');
    expect(providerFailureNotice('Team agent', f)).toBeNull();
    expect(providerFailureNotice('Team agent', classifyProviderFailure('rule-based', 'assistant turn completed without posting a reply'))).toBeNull();
  });

  it('a deployment may point the console at its own team/project page', () => {
    const f = classifyProviderFailure('xai', XAI_403, { ORCHESTRATION_XAI_BILLING_URL: 'https://console.x.ai/team/1fae4ce5/billing' });
    expect(f.url).toBe('https://console.x.ai/team/1fae4ce5/billing');
  });

  it('the notice names the assistant, the provider, what it said, that nothing is retried, and the URL', () => {
    const text = providerFailureNotice('Somali Corridor Team agent', classifyProviderFailure('xai', XAI_403))!;
    expect(text.startsWith('Somali Corridor Team agent here — I could not answer this.')).toBe(true);
    expect(text).toContain('Grok 4.20 (xAI)');
    expect(text).toContain('used its available credits or reached its spending limit (HTTP 403)');
    expect(text).toContain('used all available credits or reached its monthly spending limit');
    expect(text).toContain('will not be retried');
    expect(text).toContain(PROVIDER_BILLING_URL.xai);
  });
});
