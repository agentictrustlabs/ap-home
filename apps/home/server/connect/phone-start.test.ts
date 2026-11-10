// Security audit H-01 (2026-11-04): with no SMS provider configured, phone/start returned the sign-in code to
// whoever asked, so anyone could sign in as any phone number. The code may only come back with DEV_OTP_ECHO=true.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../_lib/home-sentry', async (orig) => ({ ...(await orig<object>()), reportHomeError: async () => {} }));

import { onRequestPost } from './phone-start';

function kv() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k), m };
}

const ask = (env: unknown) =>
  onRequestPost({
    request: new Request('https://gcid.test/connect/phone/start', { method: 'POST', body: JSON.stringify({ phone: '+15555550100' }) }),
    env,
  } as never);

describe('POST /connect/phone/start with no SMS provider', () => {
  it('refuses, never returns a code, and stores nothing', async () => {
    const env = { AUTH_CODES: kv() };
    const r = await ask(env);
    expect(r.status).toBe(503);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.devCode).toBeUndefined();
    expect(body.reason).toBe('sms_not_configured');
    expect(env.AUTH_CODES.m.size).toBe(0);
  });

  it('echoes the code only when DEV_OTP_ECHO=true (local development)', async () => {
    const env = { AUTH_CODES: kv(), DEV_OTP_ECHO: 'true' };
    const r = await ask(env);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { devCode?: string };
    expect(body.devCode).toMatch(/^\d{6}$/);
  });
});
