// THE AUTHORIZATION SERVER TOWARD MCP CLIENTS — `@agenticprimitives/mcp-oauth`'s generic OAuth 2.1 AS (RFC 8414 / 7591 /
// 7009 / 8707, PKCE S256, opaque rotating tokens), bound to this Worker's store and secret. A bearer minted here is a
// CLIENT credential — which client of which person is calling — and it never leaves this Worker (ADR-0041). Toward the
// person, this Worker is a registered relying app of the Home (`index.ts`): identity and the ask-as-me wire come from
// there, never from here.
import { authorizationServerMetadata as asMetadata, registerClient as asRegister, parseAuthorize as asParse, tokenEndpoint as asToken, revokeEndpoint as asRevoke, bearerOf as asBearer, type AuthorizationServerStore, type AuthorizeRequest } from '@agenticprimitives/mcp-oauth';
import type { Store, TokenRow } from './store.js';

export type { AuthorizeRequest };
export const PENDING_TTL_MS = 600_000;
export interface OAuthEnv { TOKEN_SECRET?: string; /** Spec 397 §11.4 — the connection-key client's access-token lifetime; unset ⇒ the AS default (an hour). */ accessTtlSeconds?: number }
const opts = (env: OAuthEnv) => ({ tokenSecret: env.TOKEN_SECRET ?? 'unset', ...(env.accessTtlSeconds ? { accessTtlSeconds: env.accessTtlSeconds } : {}) });
const asStore = (store: Store): AuthorizationServerStore => store;

export const authorizationServerMetadata = (origin: string, scopes: readonly string[]): Record<string, unknown> => asMetadata(origin, scopes);
export const registerClient = (store: Store, body: Record<string, unknown>): Promise<Response> => asRegister(asStore(store), body);
export const parseAuthorize = (store: Store, q: URLSearchParams, resourceUrl: string, scopes: readonly string[]) => asParse(asStore(store), q, resourceUrl, scopes);
export const tokenEndpoint = (env: OAuthEnv, store: Store, body: URLSearchParams, authHeader: string | null, resourceUrl: string): Promise<Response> => asToken(opts(env), asStore(store), body, authHeader, resourceUrl);
export const revokeEndpoint = (env: OAuthEnv, store: Store, body: URLSearchParams, authHeader: string | null): Promise<Response> => asRevoke(opts(env), asStore(store), body, authHeader);
export const bearerOf = (env: OAuthEnv, store: Store, authHeader: string | null, resourceUrl: string): Promise<TokenRow | null> => asBearer(opts(env), asStore(store), authHeader, resourceUrl) as Promise<TokenRow | null>;
