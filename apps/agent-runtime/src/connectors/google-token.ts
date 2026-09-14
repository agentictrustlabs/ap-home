// THE PERSON'S GOOGLE CREDENTIAL, READ ONLY HERE — shared by every Google connector (Calendar, Gmail, Drive; spec 400
// §5.8 / 402 W2). One token per (provider, person) in `FED_TOKENS`, envelope-encrypted under her SA; refreshed with the
// deployment's own client when near expiry; never returned to a caller — the connectors call the API and return data.
import type { Address } from 'viem';
import { loadFederatedToken, storeFederatedToken, deleteFederatedToken, type FederatedProvider } from '../fed-token.js';

export interface GoogleEnv { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; FED_TOKENS?: KVNamespace }
export type TokenEnv = Parameters<typeof loadFederatedToken>[0] & GoogleEnv;
export type GoogleProvider = Extract<FederatedProvider, `google-${string}`>;

/** Google's own refresh-token exchange (confidential client: id + secret). A refused refresh is a disconnected account. */
export async function refreshGoogleToken(env: GoogleEnv, refresh: string, f: typeof fetch = fetch): Promise<{ access: string; expiresIn: number | null; scope: string | null } | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
  const res = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string; scope?: string };
  if (!j.access_token) return null;
  return { access: j.access_token, expiresIn: j.expires_in != null ? Number(j.expires_in) : null, scope: j.scope ?? null };
}

/** The connection's state, for the Home and the tools: connected (which scopes, which account) or not. */
export async function connectorStatus(env: TokenEnv, sa: Address, provider: GoogleProvider): Promise<{ connected: false } | { connected: true; scope: string | null; account: string | null; scopes: string[] }> {
  const loaded = await loadFederatedToken(env, sa, provider);
  if (!loaded) return { connected: false };
  return { connected: true, scope: loaded.scope, account: loaded.appKey || null, scopes: (loaded.scope ?? '').split(' ').filter(Boolean) };
}

export async function disconnectConnector(env: TokenEnv, sa: Address, provider: GoogleProvider): Promise<void> {
  await deleteFederatedToken(env, sa, provider);
}

/** An access token for the person, refreshed when near expiry (and the refreshed one kept). `null` = not connected. */
export async function accessFor(env: TokenEnv, sa: Address, provider: GoogleProvider, f: typeof fetch): Promise<{ access: string; scope: string | null } | null> {
  const loaded = await loadFederatedToken(env, sa, provider);
  if (!loaded) return null;
  if (loaded.exp - Math.floor(Date.now() / 1000) > 60) return { access: loaded.tokens.access, scope: loaded.scope };
  if (!loaded.tokens.refresh) return null;
  const r = await refreshGoogleToken(env, loaded.tokens.refresh, f);
  if (!r) return null;
  await storeFederatedToken(env, sa, { access: r.access, refresh: loaded.tokens.refresh }, r.expiresIn, r.scope ?? loaded.scope, loaded.appKey, provider);
  return { access: r.access, scope: r.scope ?? loaded.scope };
}

/** One Google API call with the person's token; a non-2xx is an error in the API's own words. */
export async function googleApi(access: string, url: string, init: RequestInit, f: typeof fetch, label: string): Promise<Record<string, unknown>> {
  const res = await f(url, { ...init, headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(init.body && !(init.headers as Record<string, string> | undefined)?.['content-type'] ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = body.error as { message?: string; status?: string } | undefined;
    throw new Error(`${label} ${res.status}: ${err?.message ?? err?.status ?? text.slice(0, 120)}`);
  }
  return body;
}

export const hasScope = (scope: string | null, want: string): boolean => !!scope && scope.split(' ').includes(want);
