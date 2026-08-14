// SELF-SERVICE OIDC CLIENT REGISTRY (spec 230 §6, dynamic half).
//
// Until now the only way for an app to connect to this Home was an edit to
// `src/whitelabel/config.ts` and a redeploy. That made the Home a gatekeeper for a decision that
// is really the MEMBER's: which app may ask them to sign in. This module adds the member-owned
// half — a person registers their own app from their portal, and can delete it — WITHOUT
// widening what a registered app may do.
//
// TWO REGISTRIES, ONE LOOKUP, IN ONE ORDER.
//
//   1. the white-label config (static, deployment-curated, may hold privileged entries)
//   2. this KV registry (dynamic, member-owned, deliberately unprivileged)
//
// Static wins, always. A member cannot register a `client_id` that shadows a curated one — the
// lookup would ignore it anyway, and `createApp` refuses it outright so nobody builds against a
// registration that silently does nothing.
//
// WHAT A SELF-REGISTERED APP CANNOT HAVE, and why each one is withheld:
//
//   `socialCustody`          — turns a social sign-in into a KMS-CUSTODIED Smart Agent. That is
//                              custody, granted by registration. Curated entries only.
//   `paymentConfig`          — mints payment mandates against the member's treasury.
//   `collectionConfig`       — redeems other people's pull mandates.
//   `operational_delegate`   — an org→service-agent operational grant.
//   privileged templates     — `jp-data-access`, `x402-pay`, `subscription-collect`,
//                              `content-signer`, `service-agent-wire`. Each fixes a caveat set
//                              that reaches further than sign-in.
//
// A self-registered app gets exactly what a relying app needs: `site-login` and `org-create`.
// Both end in a delegation the PERSON signs, scoped by a template they cannot widen, revocable
// on-chain without asking this Home. That is the whole reason self-service is safe here: the
// registration decides who may ASK, and the person still decides every time whether to grant.

import type { RelyingApp } from '../../src/whitelabel/schema';
import {
  getClient as getStaticClient,
  isAllowedClientOrigin as isAllowedClientOriginStatic,
  isAllowedRelyingOrigin as isAllowedRelyingOriginStatic,
} from '../../src/lib/oidc-clients';

/** Minimal KV surface (mirrors `server-broker.ts` — avoids a workers-types dep here). */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface RegistryEnv {
  AUTH_CODES: KVNamespace;
}

/** A member-registered client. A superset of what the OIDC gates read, plus provenance. */
export interface RegisteredApp {
  client_id: string;
  name: string;
  description?: string;
  homepage?: string;
  /** Lowercased Smart Agent address of the member who registered it. Only they may edit it. */
  owner: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_delegation_templates: string[];
  delegate: `0x${string}`;
  createdAt: string;
  updatedAt: string;
  /** Suspended by its owner. Kept, not deleted, so the client_id stays claimed. */
  disabled?: boolean;
}

/** Templates a member may register for. Everything else is curated-only, deliberately. */
export const SELF_SERVICE_TEMPLATES = ['site-login', 'org-create'] as const;
export const SELF_SERVICE_SCOPES = ['openid', 'profile', 'agent'] as const;

const MAX_APPS_PER_OWNER = 10;
const MAX_REDIRECTS = 8;

const APP_KEY = (clientId: string): string => `oidc-app:${clientId.toLowerCase()}`;
const OWNER_KEY = (owner: string): string => `oidc-app-owner:${owner.toLowerCase()}`;
const ORIGIN_KEY = (origin: string): string => `oidc-app-origin:${origin.toLowerCase()}`;

// ── Validation ────────────────────────────────────────────────────────────────────────────────

export type RegistrationError =
  | 'client_id_invalid'
  | 'client_id_taken'
  | 'client_id_reserved'
  | 'name_required'
  | 'no_redirect_uris'
  | 'too_many_redirect_uris'
  | 'redirect_uri_invalid'
  | 'redirect_uri_insecure'
  | 'redirect_uri_is_home'
  | 'redirect_uri_claimed'
  | 'template_not_allowed'
  | 'scope_not_allowed'
  | 'delegate_invalid'
  | 'quota_exceeded'
  | 'not_owner'
  | 'not_found';

export class RegistrationRefused extends Error {
  constructor(readonly reason: RegistrationError, message: string) {
    super(message);
    this.name = 'RegistrationRefused';
  }
}

/** `commons-app`, `my-thing-2`. Lowercase, 3–40, no leading/trailing dash. */
export function isValidClientId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(id) && !id.includes('--');
}

/**
 * Is this redirect URI safe to hand an authorization code to?
 *
 * The rules, and the reason each exists:
 *  · https, or http on loopback only — a code delivered over plaintext to a real host is a code
 *    on the wire. Loopback is exempt because there is no wire.
 *  · no fragment, no wildcard, no credentials — the match downstream is EXACT (CN-1), so
 *    anything that makes "exact" ambiguous is refused at registration rather than at use.
 *  · not on the Home's own zone — an app whose redirect lives at `*.<home zone>` would be
 *    same-site with the Home for cookie purposes. Registration must not be a way to move onto
 *    the Home's origin.
 */
export function validateRedirectUri(uri: string, homeZone: string): RegistrationError | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri_invalid';
  }
  if (u.hash) return 'redirect_uri_invalid';
  if (u.username || u.password) return 'redirect_uri_invalid';
  if (u.hostname.includes('*')) return 'redirect_uri_invalid';

  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'redirect_uri_insecure';

  const zone = homeZone.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (zone) {
    const host = u.hostname.toLowerCase();
    if (host === zone || host.endsWith('.' + zone)) return 'redirect_uri_is_home';
  }
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────

/** The dynamic record for `clientId`, or null. Does NOT consult the static registry. */
export async function getRegisteredApp(env: RegistryEnv, clientId: string): Promise<RegisteredApp | null> {
  if (!clientId || !isValidClientId(clientId.toLowerCase())) return null;
  const raw = await env.AUTH_CODES.get(APP_KEY(clientId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RegisteredApp;
  } catch {
    return null;
  }
}

/** Project a member registration onto the shape the OIDC gates already consume. */
export function toOidcClient(app: RegisteredApp): RelyingApp {
  return {
    client_id: app.client_id,
    name: app.name,
    redirect_uris: app.redirect_uris,
    allowed_scopes: app.allowed_scopes,
    allowed_delegation_templates: app.allowed_delegation_templates,
    delegate: app.delegate,
    // Privileged fields are ABSENT rather than false — there is nothing to flip, so a future
    // refactor that reads them optimistically still cannot find a grant here.
  };
}

/**
 * The ONE client lookup the OIDC gates should use.
 *
 * Static first (curated entries win and cannot be shadowed), then the member registry. A
 * disabled registration resolves to null — the same answer as an unknown client, because to a
 * caller they mean the same thing: you may not proceed.
 */
export async function resolveClient(env: RegistryEnv, clientId: string): Promise<RelyingApp | null> {
  const staticHit = getStaticClient(clientId);
  if (staticHit) return staticHit;
  const dyn = await getRegisteredApp(env, clientId);
  if (!dyn || dyn.disabled) return null;
  return toOidcClient(dyn);
}

/**
 * Is `origin` the origin of some registered client's redirect URI?
 *
 * Backed by an origin→client_id index written at registration, so this is one KV read rather
 * than a scan. The index is maintained by `createApp`/`updateApp`/`deleteApp`; a stale entry
 * fails the exact redirect check downstream anyway, so it can widen CORS but never authorize.
 */
export async function isRegisteredOrigin(env: RegistryEnv, origin: string): Promise<boolean> {
  if (!origin) return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }
  const clientId = await env.AUTH_CODES.get(ORIGIN_KEY(normalized));
  if (!clientId) return false;
  const app = await getRegisteredApp(env, clientId);
  return !!app && !app.disabled;
}

/**
 * Is `redirectUri`'s ORIGIN one this Home will hand a code to / talk CORS with?
 *
 * Static allowlist first, then the member registry. Same order and same reason as
 * `resolveClient`: a curated origin is never overridden by a registration.
 */
export async function isAllowedRelyingOriginAsync(env: RegistryEnv, redirectUri: string): Promise<boolean> {
  if (isAllowedRelyingOriginStatic(redirectUri)) return true;
  try {
    return await isRegisteredOrigin(env, new URL(redirectUri).origin);
  } catch {
    return false;
  }
}

/** CORS headers for a relying-app origin, or `{}`. The one place both registries are consulted. */
export async function relyingCors(request: Request, env: RegistryEnv): Promise<Record<string, string>> {
  const origin = request.headers.get('Origin') ?? '';
  if (!origin) return {};
  if (isAllowedClientOriginStatic(origin) || (await isRegisteredOrigin(env, origin))) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      vary: 'Origin',
    };
  }
  return {};
}

/** Every app this member registered. */
export async function listAppsForOwner(env: RegistryEnv, owner: string): Promise<RegisteredApp[]> {
  const raw = await env.AUTH_CODES.get(OWNER_KEY(owner));
  const ids = raw ? (JSON.parse(raw) as string[]) : [];
  const apps = await Promise.all(ids.map((id) => getRegisteredApp(env, id)));
  return apps.filter((a): a is RegisteredApp => a !== null);
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────

export interface AppInput {
  client_id: string;
  name: string;
  description?: string;
  homepage?: string;
  redirect_uris: string[];
  allowed_delegation_templates?: string[];
  allowed_scopes?: string[];
  delegate?: string;
}

interface WriteContext {
  /** Registrable zone of this Home, e.g. `impact-agent.me`. Redirects may not live here. */
  homeZone: string;
  /** The delegate a registration gets when it names none. */
  defaultDelegate: `0x${string}`;
}

function refuse(reason: RegistrationError, message: string): never {
  throw new RegistrationRefused(reason, message);
}

function normalizeInput(input: AppInput, ctx: WriteContext): Omit<RegisteredApp, 'owner' | 'createdAt' | 'updatedAt'> {
  const client_id = String(input.client_id ?? '').trim().toLowerCase();
  if (!isValidClientId(client_id)) {
    refuse('client_id_invalid', 'App ID must be 3–40 lowercase letters, digits or single dashes.');
  }
  const name = String(input.name ?? '').trim();
  if (!name) refuse('name_required', 'Give the app a name — people see it on the consent screen.');

  const uris = (input.redirect_uris ?? []).map((u) => String(u).trim()).filter(Boolean);
  if (uris.length === 0) refuse('no_redirect_uris', 'At least one redirect URI is required.');
  if (uris.length > MAX_REDIRECTS) refuse('too_many_redirect_uris', `At most ${MAX_REDIRECTS} redirect URIs.`);
  for (const u of uris) {
    const err = validateRedirectUri(u, ctx.homeZone);
    if (err) {
      refuse(
        err,
        err === 'redirect_uri_is_home'
          ? `${u} is on this Home's own domain — an app cannot redirect there.`
          : err === 'redirect_uri_insecure'
            ? `${u} must use https (http is allowed only on localhost).`
            : `${u} is not a usable redirect URI.`,
      );
    }
  }

  const templates = input.allowed_delegation_templates?.length
    ? input.allowed_delegation_templates
    : ['site-login'];
  for (const t of templates) {
    if (!(SELF_SERVICE_TEMPLATES as readonly string[]).includes(t)) {
      refuse('template_not_allowed', `"${t}" is not available to self-registered apps.`);
    }
  }

  const scopes = input.allowed_scopes?.length ? input.allowed_scopes : ['openid', 'agent'];
  for (const s of scopes) {
    if (!(SELF_SERVICE_SCOPES as readonly string[]).includes(s)) {
      refuse('scope_not_allowed', `"${s}" is not an available scope.`);
    }
  }

  const delegate = (input.delegate ?? ctx.defaultDelegate).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(delegate)) {
    refuse('delegate_invalid', 'The delegate must be a 0x-prefixed 20-byte address.');
  }

  return {
    client_id,
    name,
    ...(input.description ? { description: String(input.description).slice(0, 500) } : {}),
    ...(input.homepage ? { homepage: String(input.homepage).slice(0, 300) } : {}),
    redirect_uris: uris,
    allowed_scopes: scopes,
    allowed_delegation_templates: templates,
    delegate: delegate.toLowerCase() as `0x${string}`,
  };
}

/** Add/remove the origin→client index entries for a set of redirect URIs. */
async function reindexOrigins(
  env: RegistryEnv,
  clientId: string,
  previous: string[],
  next: string[],
): Promise<void> {
  const originsOf = (uris: string[]): Set<string> => {
    const out = new Set<string>();
    for (const u of uris) {
      try {
        out.add(new URL(u).origin.toLowerCase());
      } catch {
        /* validated upstream; skip rather than throw mid-write */
      }
    }
    return out;
  };
  const before = originsOf(previous);
  const after = originsOf(next);
  // Drop origins this app no longer claims — but only if THIS app is the one holding the index
  // entry, so removing a URI never revokes another app's origin.
  for (const o of before) {
    if (after.has(o)) continue;
    const holder = await env.AUTH_CODES.get(ORIGIN_KEY(o));
    if (holder && holder.toLowerCase() === clientId.toLowerCase()) await env.AUTH_CODES.delete(ORIGIN_KEY(o));
  }
  for (const o of after) {
    if (before.has(o)) continue;
    await env.AUTH_CODES.put(ORIGIN_KEY(o), clientId.toLowerCase());
  }
}

export async function createApp(
  env: RegistryEnv,
  owner: string,
  input: AppInput,
  ctx: WriteContext,
): Promise<RegisteredApp> {
  const normalized = normalizeInput(input, ctx);

  // A curated client_id is not available, even though the lookup would ignore a shadow. Letting
  // someone "register" a name that resolves to somebody else's entry produces an app that
  // appears configured and never works.
  if (getStaticClient(normalized.client_id)) {
    refuse('client_id_reserved', `"${normalized.client_id}" is reserved by this Home.`);
  }
  if (await getRegisteredApp(env, normalized.client_id)) {
    refuse('client_id_taken', `"${normalized.client_id}" is already registered.`);
  }

  // Each redirect ORIGIN belongs to one app. Without this, two apps could claim the same origin
  // and the CORS index would answer for whichever wrote last.
  for (const uri of normalized.redirect_uris) {
    const origin = new URL(uri).origin.toLowerCase();
    const holder = await env.AUTH_CODES.get(ORIGIN_KEY(origin));
    if (holder && holder.toLowerCase() !== normalized.client_id) {
      refuse('redirect_uri_claimed', `${origin} is already registered by another app.`);
    }
  }

  const mine = await listAppsForOwner(env, owner);
  if (mine.length >= MAX_APPS_PER_OWNER) {
    refuse('quota_exceeded', `You can register up to ${MAX_APPS_PER_OWNER} apps.`);
  }

  const now = new Date().toISOString();
  const app: RegisteredApp = { ...normalized, owner: owner.toLowerCase(), createdAt: now, updatedAt: now };
  await env.AUTH_CODES.put(APP_KEY(app.client_id), JSON.stringify(app));
  await reindexOrigins(env, app.client_id, [], app.redirect_uris);
  await env.AUTH_CODES.put(OWNER_KEY(owner), JSON.stringify([...mine.map((a) => a.client_id), app.client_id]));
  return app;
}

export async function updateApp(
  env: RegistryEnv,
  owner: string,
  clientId: string,
  input: Omit<AppInput, 'client_id'> & { disabled?: boolean },
  ctx: WriteContext,
): Promise<RegisteredApp> {
  const existing = await getRegisteredApp(env, clientId);
  if (!existing) refuse('not_found', 'No such app.');
  // Ownership is checked against the record, never against a field in the request.
  if (existing.owner.toLowerCase() !== owner.toLowerCase()) refuse('not_owner', 'This app belongs to someone else.');

  const normalized = normalizeInput({ ...input, client_id: existing.client_id }, ctx);
  for (const uri of normalized.redirect_uris) {
    const origin = new URL(uri).origin.toLowerCase();
    const holder = await env.AUTH_CODES.get(ORIGIN_KEY(origin));
    if (holder && holder.toLowerCase() !== existing.client_id.toLowerCase()) {
      refuse('redirect_uri_claimed', `${origin} is already registered by another app.`);
    }
  }

  const app: RegisteredApp = {
    ...normalized,
    owner: existing.owner,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    ...(input.disabled ? { disabled: true } : {}),
  };
  await env.AUTH_CODES.put(APP_KEY(app.client_id), JSON.stringify(app));
  await reindexOrigins(env, app.client_id, existing.redirect_uris, app.redirect_uris);
  return app;
}

/**
 * Delete a registration.
 *
 * Worth being precise about what this does and does not do: it stops the Home ISSUING new
 * tokens for the client_id. It does NOT revoke the delegations members already signed for that
 * app — those are on-chain artifacts, and killing them is an on-chain revoke each member makes
 * from their own authority page. Saying otherwise would be the exact "revocation is a registry
 * edit" claim that per-app grants exist to replace.
 */
export async function deleteApp(env: RegistryEnv, owner: string, clientId: string): Promise<void> {
  const existing = await getRegisteredApp(env, clientId);
  if (!existing) refuse('not_found', 'No such app.');
  if (existing.owner.toLowerCase() !== owner.toLowerCase()) refuse('not_owner', 'This app belongs to someone else.');

  await reindexOrigins(env, existing.client_id, existing.redirect_uris, []);
  await env.AUTH_CODES.delete(APP_KEY(existing.client_id));
  const mine = await listAppsForOwner(env, owner);
  await env.AUTH_CODES.put(
    OWNER_KEY(owner),
    JSON.stringify(mine.filter((a) => a.client_id !== existing.client_id).map((a) => a.client_id)),
  );
}
