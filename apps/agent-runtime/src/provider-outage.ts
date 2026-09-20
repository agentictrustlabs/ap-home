/**
 * WHEN THE MODEL PROVIDER IS THE REASON THERE IS NO ANSWER, THE PERSON IS TOLD — IN THE TOPIC.
 *
 * A topic assistant's turn is dispatched once and never retried (spec 327 §3, ADR-0013). Until now a
 * provider refusing the call was AUDITED (`interactions.assistant.dispatchFailed`) and otherwise silent:
 * the person who asked saw a thinking indicator run out, then a panel saying the agent "has not
 * answered yet". On 2026-09-20 the estate's only offered provider ran out of credits and every Ask on it
 * failed exactly this way — the reason sat in the Worker log where nobody waiting on an answer looks.
 *
 * This module classifies a failed turn's error string and, for the failures a person can ACT on — the
 * account is out of credit or over its quota — writes the note the assistant posts instead of an answer:
 * which provider, what it said, and the console where whoever runs this Home can see and fix it. The
 * note is posted BY the assistant AS a topic message, so every surface that reads the topic (Field's Ask
 * panel, Home's discussions) shows it where the answer would have been. Nothing is retried and no other
 * provider is tried (ADR-0013): the note says so.
 *
 * Errors this cannot attribute to the account stay as they were — audited, not posted — because a note
 * that says "something failed" is noise in a persistent topic; one that says what to do is not.
 */

import type { LlmProvider, PlannerKind } from './orchestration.js';

export type ProviderFailureKind = 'exhausted' | 'rate-limited' | 'other';

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly provider: LlmProvider | 'rule-based' | 'unknown';
  /** What the provider is called to a person (`Grok 4.20 (xAI)`), never the internal id. */
  readonly label: string;
  /** HTTP status the provider answered with, when the error string carries one. */
  readonly status?: number;
  /** Where the account's credit / quota is seen and fixed — only set for a provider this module knows. */
  readonly url?: string;
  /** The provider's own words, clipped — the person sees what the operator would see. */
  readonly detail: string;
}

const LABEL: Record<LlmProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  groq: 'GPT-OSS 120B (Groq)',
  openai: 'GPT-5 mini (OpenAI)',
  xai: 'Grok 4.20 (xAI)',
  gemini: 'Gemini 3.5 Flash (Google)',
};

/** The console each provider's billing / quota lives at. Overridable per deployment by
 *  `ORCHESTRATION_<PROVIDER>_BILLING_URL` so an estate can point at the exact team or project page. */
export const PROVIDER_BILLING_URL: Record<LlmProvider, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  groq: 'https://console.groq.com/settings/billing',
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  xai: 'https://console.x.ai/',
  gemini: 'https://aistudio.google.com/',
};

const PROVIDERS = new Set<string>(Object.keys(LABEL));

/** "used all available credits", "credit balance is too low", "insufficient_quota", "quota exceeded",
 *  "spending limit", "billing", HTTP 402 — the account, not the minute, is what ran out. */
const EXHAUSTED = /\bcredits?\b|credit[_ ]balance|insufficient[_ ]quota|quota|spending[_ ]limit|usage[_ ]limit|billing|payment[_ ]required|out of tokens|RESOURCE_EXHAUSTED/i;
/** A minute's allowance — the same call later would carry. */
const RATE_LIMITED = /rate[_ ]limit|retry[_ ]after|tokens per (minute|day)|\bTPM\b|\bRPM\b|too many requests/i;

export function classifyProviderFailure(
  plannerKind: PlannerKind | string | undefined,
  message: string | undefined,
  env: Record<string, unknown> = {},
): ProviderFailure {
  const text = String(message ?? '');
  const provider: ProviderFailure['provider'] =
    plannerKind && PROVIDERS.has(plannerKind) ? (plannerKind as LlmProvider) : plannerKind === 'rule-based' ? 'rule-based' : 'unknown';
  const status = Number(/\(HTTP (\d{3})/.exec(text)?.[1] ?? NaN);
  const known = provider !== 'rule-based' && provider !== 'unknown' ? provider : null;
  const label = known ? LABEL[known] : 'the model provider';
  const override = known ? env[`ORCHESTRATION_${known.toUpperCase()}_BILLING_URL`] : undefined;
  const url = known ? (typeof override === 'string' && override.trim() ? override.trim() : PROVIDER_BILLING_URL[known]) : undefined;
  // The provider's detail follows the first ": " after the HTTP status; the prefix is our adapter's, not theirs.
  const afterStatus = /\(HTTP \d{3}[^)]*\):\s*([\s\S]+)$/.exec(text)?.[1] ?? text;
  const detail = providerWords(afterStatus).replace(/\s+/g, ' ').trim().slice(0, 300);
  const kind: ProviderFailureKind =
    status === 402 || EXHAUSTED.test(text) ? 'exhausted' : status === 429 || RATE_LIMITED.test(text) ? 'rate-limited' : 'other';
  return { kind, provider, label, ...(Number.isFinite(status) ? { status } : {}), ...(url ? { url } : {}), detail };
}

/** A provider's body is usually JSON — `{"error":"…"}`, `{"error":{"message":"…"}}`, `{"message":"…"}`. The person
 *  gets the sentence, not the envelope; anything else is kept as it came. */
function providerWords(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('{')) return t;
  try {
    const j = JSON.parse(t) as { error?: unknown; message?: unknown };
    const e = j.error;
    if (typeof e === 'string' && e.trim()) return e;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
    if (typeof j.message === 'string' && j.message.trim()) return j.message;
  } catch { /* not JSON after all — the words are the body */ }
  return t;
}

/** The topic message the assistant posts in place of an answer, or null when the failure is not one a
 *  person can address from a console (those stay audit-only). */
export function providerFailureNotice(displayName: string, f: ProviderFailure): string | null {
  if (f.kind === 'other') return null;
  const http = f.status ? ` (HTTP ${f.status})` : '';
  const said = f.detail ? ` It said: “${f.detail}”` : '';
  const where = f.url ? ` Whoever runs this Home can check and fix it at ${f.url}, then ask again.` : ' Whoever runs this Home needs to check the provider account, then ask again.';
  if (f.kind === 'exhausted') {
    return (
      `${displayName} here — I could not answer this. The model I run on, ${f.label}, refused the call because ` +
      `its account has used its available credits or reached its spending limit${http}.${said}` +
      ` Nothing was answered and this question will not be retried.${where}`
    );
  }
  return (
    `${displayName} here — I could not answer this. The model I run on, ${f.label}, is rate-limited right now${http}.${said}` +
    ` Nothing was answered and this question will not be retried — ask again in a minute.` +
    (f.url ? ` If it keeps happening, the plan's limits are at ${f.url}.` : '')
  );
}
