'use client';
// Browser-side resolution of MEMBER-REGISTERED OIDC clients.
//
// Curated clients are compiled into this bundle (`whitelabel.relyingApps`), so every gate that
// runs in the browser — the "request blocked" screen, the exact-origin postMessage target — can
// decide synchronously. Member registrations live in KV and cannot be, so the sign-in page has
// to LOOK ONE UP before it can decide.
//
// The shape that makes this safe: resolve first, decide second. `primeRelyingClient` performs
// the lookup; the sync predicates below then answer from what was resolved. A caller that has
// not primed gets the static answer, which is the conservative one. Nothing here ever downgrades
// a decision because a lookup failed — an unresolved client stays blocked, and the SERVER
// re-checks the same registry on every request regardless of what the browser concluded.

import { getClient, isAllowedRelyingOrigin, type OidcClient } from './oidc-clients';

/** Resolved member registrations, keyed by client_id. `null` = looked up, does not exist. */
const resolved = new Map<string, OidcClient | null>();
/** Origins belonging to a resolved registration — the browser-side half of the origin allowlist. */
const resolvedOrigins = new Set<string>();
/** In-flight lookups, so a component that mounts twice does not fetch twice. */
const inflight = new Map<string, Promise<OidcClient | null>>();

interface ClientInfoResponse {
  ok?: boolean;
  client?: {
    client_id: string;
    name: string | null;
    redirect_uris: string[];
    allowed_delegation_templates: string[];
    allowed_scopes: string[];
    delegate: `0x${string}`;
  };
}

/**
 * Look up `clientId` and remember the answer.
 *
 * Returns the curated entry immediately when there is one — a member registration can never
 * shadow a curated client, so there is nothing to fetch. Otherwise asks `/connect/client-info`.
 * Resolves to `null` for an unknown, disabled, or unreachable client; the caller treats all
 * three as "not registered", because for the purpose of showing a sign-in they are.
 */
export async function primeRelyingClient(clientId: string): Promise<OidcClient | null> {
  if (!clientId) return null;
  const staticHit = getClient(clientId);
  if (staticHit) return staticHit;
  if (resolved.has(clientId)) return resolved.get(clientId) ?? null;

  const existing = inflight.get(clientId);
  if (existing) return existing;

  const task = (async (): Promise<OidcClient | null> => {
    try {
      const r = await fetch(`/connect/client-info?client_id=${encodeURIComponent(clientId)}`, {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) return null;
      const body = (await r.json()) as ClientInfoResponse;
      if (!body.ok || !body.client) return null;
      const client: OidcClient = {
        client_id: body.client.client_id,
        name: body.client.name ?? undefined,
        redirect_uris: body.client.redirect_uris,
        allowed_scopes: body.client.allowed_scopes,
        allowed_delegation_templates: body.client.allowed_delegation_templates,
        delegate: body.client.delegate,
      };
      for (const uri of client.redirect_uris) {
        try {
          resolvedOrigins.add(new URL(uri).origin);
        } catch {
          /* a malformed registered URI just does not widen the allowlist */
        }
      }
      return client;
    } catch {
      return null;
    }
  })();

  inflight.set(clientId, task);
  const result = await task;
  inflight.delete(clientId);
  resolved.set(clientId, result);
  return result;
}

/** The curated OR already-resolved client for `clientId`. Sync — prime first. */
export function knownRelyingClient(clientId: string | undefined | null): OidcClient | null {
  if (!clientId) return null;
  return getClient(clientId) ?? resolved.get(clientId) ?? null;
}

/**
 * Is `redirectUri`'s origin one this Home will deliver a code to?
 *
 * Curated allowlist first, then origins learned from a primed registration. Used for the
 * exact-origin `postMessage` target and the blocked screen, so a `false` here must stop the
 * flow — never widen it to make a login work.
 */
export function relyingOriginAllowed(redirectUri: string): boolean {
  if (isAllowedRelyingOrigin(redirectUri)) return true;
  try {
    return resolvedOrigins.has(new URL(redirectUri).origin);
  } catch {
    return false;
  }
}
