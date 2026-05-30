// OIDC client registry (spec 230 §6). client_id → allowed redirect_uris, scopes,
// and delegation templates. Authoritative server-side gate at the grant endpoint + /token:
// redirect_uri MUST exact-match (CN-1 / open-redirect defense); the requested
// delegation_template MUST be allowed (the template fixes the caveat set — the client
// cannot widen it). The registry is SOURCED FROM the white-label config (spec 234 §5 /
// W1) — a deployment configures its relying apps there, not in this generic gate.

import { whitelabel } from '../whitelabel/config';
import type { RelyingApp } from '../whitelabel/config';

/** An OIDC client = a configured relying app (spec 234). */
export type OidcClient = RelyingApp;

const CLIENTS: Record<string, OidcClient> = Object.fromEntries(
  whitelabel.relyingApps.map((c) => [c.client_id, c]),
);

export function getClient(clientId: string): OidcClient | null {
  return CLIENTS[clientId] ?? null;
}

/** Exact-match redirect allowlist (CN-1). Never substring/prefix. */
export function clientAllowsRedirect(client: OidcClient, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

export function clientAllowsTemplate(client: OidcClient, template: string): boolean {
  return client.allowed_delegation_templates.includes(template);
}

/** Is `origin` the origin of a registered client's redirect_uri? (CORS allowlist for the
 *  cross-origin OIDC endpoints — /token, /jwks — called by the relying-site SPA.) */
export function isAllowedClientOrigin(origin: string): boolean {
  return ALLOWED_RELYING_ORIGINS.has(origin);
}

/** SEC-005: the single source of truth for "which relying-app origins this broker trusts"
 *  is the whitelabel `relyingApps` registry. Derived at module init from
 *  `relyingApps[].redirect_uris`. Replaces the previously hardcoded
 *  `ALLOWED_RELYING_ORIGINS` list in `useEnrollReq.ts` so the two can't drift. */
export const ALLOWED_RELYING_ORIGINS: ReadonlySet<string> = new Set(
  whitelabel.relyingApps.flatMap((c) =>
    c.redirect_uris
      .map((u) => {
        try { return new URL(u).origin; } catch { return null; }
      })
      .filter((s): s is string => !!s),
  ),
);

/** True iff `redirectUri`'s origin is in the derived allowlist. Used by relying-app
 *  handoff endpoints (/profile, /wea-sign) for the audit-F3 origin gate. */
export function isAllowedRelyingOrigin(redirectUri: string): boolean {
  try {
    return ALLOWED_RELYING_ORIGINS.has(new URL(redirectUri).origin);
  } catch {
    return false;
  }
}

/** SEC-001 closure helper: the relying-app config IS the authoritative source for the
 *  delegate SA. URL-supplied `delegate` is treated as untrusted hint. */
export function getClientDelegate(client: OidcClient): `0x${string}` {
  return client.delegate;
}
