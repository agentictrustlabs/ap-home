// Static OIDC client registry (spec 230 §6). client_id → allowed redirect_uris, scopes,
// and delegation templates. Authoritative server-side gate at the grant endpoint + /token:
// redirect_uri MUST exact-match (CN-1 / open-redirect defense); the requested
// delegation_template MUST be allowed (the template fixes the caveat set — the client
// cannot widen it). Static first; KV/D1-backed later (dynamic registration is out of scope).

export interface OidcClient {
  client_id: string;
  /** Exact-match redirect URIs (no substring/prefix). */
  redirect_uris: string[];
  allowed_scopes: string[];
  /** Delegation caveat templates this client may request (spec 230 §6 / §7). */
  allowed_delegation_templates: string[];
}

const CLIENTS: Record<string, OidcClient> = {
  'demo-org': {
    client_id: 'demo-org',
    redirect_uris: ['https://agenticprimitives-demo-org.pages.dev/', 'http://localhost:5473/'],
    allowed_scopes: ['openid', 'agent'],
    allowed_delegation_templates: ['site-login', 'org-create'],
  },
};

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
  for (const c of Object.values(CLIENTS)) {
    for (const r of c.redirect_uris) {
      try {
        if (new URL(r).origin === origin) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}
