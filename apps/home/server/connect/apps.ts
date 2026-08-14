// /connect/apps — the member's own OIDC client registrations (spec 230 §6, self-service half).
//
// A member registers an app they are building, so it can send people here to sign in. The
// registration decides who may ASK; it grants nothing. Every sign-in is still a ceremony the
// person runs with their own credential, ending in a delegation they sign and can revoke
// on-chain without this Home's involvement.
//
// AUTHORIZED BY THE HOME SESSION ONLY — deliberately not by a relying app's id_token.
//
// Almost every other /connect route accepts a registered relying app's token as well, because
// those routes let an app act for the person on surfaces they connected it to. This one is
// different in kind: it is the surface that decides WHICH APPS EXIST. An app able to call it
// could register more apps under the member's name, including one whose redirect it controls —
// registration bootstrapping registration. So the token that reaches here must be the person's
// own Home session, and there is no fallback (ADR-0013).

import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { CONNECT_DOMAIN } from '../../src/lib/domain';
import {
  createApp,
  deleteApp,
  listAppsForOwner,
  RegistrationRefused,
  SELF_SERVICE_SCOPES,
  SELF_SERVICE_TEMPLATES,
  updateApp,
  type AppInput,
} from '../_lib/oidc-registry';

/** The delegate a registration inherits when it names none — the shared relying-site delegate. */
const DEFAULT_DELEGATE = '0x89D13c596c45E4eE80Af5ae06C727FE9A820ffD0' as const;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

/** The person SA behind a HOME session token, or null. No relying-token branch — see the header. */
async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, {
    keys,
    expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso',
    expectedIss: ownIssuer(request, env),
  });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

const writeContext = { homeZone: CONNECT_DOMAIN, defaultDelegate: DEFAULT_DELEGATE } as const;

/** What a developer needs to paste into their app, computed once and returned with every list. */
function integration(request: Request, env: FnContext['env']) {
  const issuer = ownIssuerOrigin(request, env);
  return {
    issuer,
    discovery: `${issuer}/.well-known/openid-configuration`,
    authorizationEndpoint: `${issuer}/`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
    responseType: 'code',
    codeChallengeMethod: 'S256',
    availableScopes: [...SELF_SERVICE_SCOPES],
    availableTemplates: [...SELF_SERVICE_TEMPLATES],
    // Said plainly because it is the thing developers get wrong first: a named member's Home is
    // their own subdomain, so an app must accept BOTH as the token issuer.
    issuerNote:
      `A member with a claimed name signs in at https://<label>.${CONNECT_DOMAIN}, so accept the apex ` +
      `and any single-label subdomain of ${CONNECT_DOMAIN} as the id_token issuer — and nothing else.`,
  };
}

function ownIssuerOrigin(request: Request, env: FnContext['env']): string {
  // `ownIssuer` returns a PREDICATE (is this iss acceptable); the origin we want to SHOW is the
  // one this request arrived on, which is what a member's app will actually talk to.
  void env;
  try {
    return new URL(request.url).origin;
  } catch {
    return `https://www.${CONNECT_DOMAIN}`;
  }
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const apps = await listAppsForOwner(env, person);
  return jsonCors({ ok: true, apps, integration: integration(request, env) }, request);
};

interface PostBody extends Partial<AppInput> {
  action?: 'create' | 'update' | 'delete';
  disabled?: boolean;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);

  const body = (await request.json().catch(() => null)) as PostBody | null;
  if (!body?.action) return jsonCors({ error: 'action required' }, request, 400);

  try {
    if (body.action === 'delete') {
      if (!body.client_id) return jsonCors({ error: 'client_id required' }, request, 400);
      await deleteApp(env, person, body.client_id);
      return jsonCors({ ok: true }, request);
    }

    const input: AppInput = {
      client_id: String(body.client_id ?? ''),
      name: String(body.name ?? ''),
      ...(body.description ? { description: body.description } : {}),
      ...(body.homepage ? { homepage: body.homepage } : {}),
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [],
      ...(body.allowed_delegation_templates ? { allowed_delegation_templates: body.allowed_delegation_templates } : {}),
      ...(body.allowed_scopes ? { allowed_scopes: body.allowed_scopes } : {}),
      ...(body.delegate ? { delegate: body.delegate } : {}),
    };

    const app =
      body.action === 'create'
        ? await createApp(env, person, input, writeContext)
        : await updateApp(
            env,
            person,
            input.client_id,
            { ...input, ...(body.disabled !== undefined ? { disabled: body.disabled } : {}) },
            writeContext,
          );
    return jsonCors({ ok: true, app, integration: integration(request, env) }, request);
  } catch (e) {
    if (e instanceof RegistrationRefused) {
      // The reason travels as a code so the form can highlight the offending field, and as prose
      // so the person reads why rather than a rule number.
      return jsonCors({ error: e.message, code: e.reason }, request, e.reason === 'not_owner' ? 403 : 400);
    }
    return jsonCors({ error: e instanceof Error ? e.message : String(e) }, request, 500);
  }
};
