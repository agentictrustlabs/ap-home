// /connect/resolution — the Home's proxy to the live private-resolution Workers (spec 338 W6-b).
//
// WHY A PROXY AND NOT A DIRECT BROWSER CALL: `demo-publications` and `demo-resolver` gate their WRITE
// routes with operator bearer tokens. Those authenticate whoever runs the store — they are not
// authority, but they must not reach a browser, so the Home holds them server-side and forwards.
//
// WHAT THE HOME DOES **NOT** DO: sign. The publication and the grant arrive already signed by the
// principal's custody path (SIWE EOA / passkey SA / KMS), and the Workers verify those signatures
// ON-CHAIN before storing. If the Home signed on the user's behalf, the whole "the principal
// authorized this" claim would collapse into "the Home said so".
//
// So: the Home is a courier for the operator token. Every authority decision happens elsewhere —
// signature at the Worker, on-chain; delegation at the origin (ADR-0056).

import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';

interface ResolutionEnv {
  /** Live Worker origins. Absent ⇒ the feature reports itself unconfigured rather than half-working. */
  PUBLICATIONS_URL?: string;
  RESOLVER_URL?: string;
  /** Operator bearers. Server-side ONLY — never sent to the browser. */
  PUBLISH_TOKEN?: string;
  ISSUE_TOKEN?: string;
}

export interface ResolutionConfig {
  publicationsUrl: string;
  resolverUrl: string;
  publishToken: string;
  issueToken: string;
}

/** Fail-closed on configuration: an unconfigured Home reports it, rather than silently no-op'ing. */
export function resolutionConfig(env: ResolutionEnv): ResolutionConfig | null {
  const publicationsUrl = (env.PUBLICATIONS_URL ?? '').trim();
  const resolverUrl = (env.RESOLVER_URL ?? '').trim();
  const publishToken = (env.PUBLISH_TOKEN ?? '').trim();
  const issueToken = (env.ISSUE_TOKEN ?? '').trim();
  if (!publicationsUrl || !resolverUrl || !publishToken || !issueToken) return null;
  return { publicationsUrl, resolverUrl, publishToken, issueToken };
}

export type ResolutionAction =
  | { action: 'publish'; publication: unknown }
  // `delegation` is present only when the issuer acts under an appointment; the resolver reads the
  // grant's SIGNED `authorityRef` to decide which case it is, never this field's presence.
  | { action: 'issue'; grant: unknown; delegation?: unknown }
  | { action: 'revoke'; grantId: string }
  | { action: 'read'; channelId: string };

async function forward(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    // A Worker we cannot reach is a failure, never an optimistic success.
    return { status: 502, body: { ok: false, error: 'upstream_unreachable', detail: String(e) } };
  }
}

/**
 * Handle one resolution action on behalf of an authenticated Home session.
 *
 * The session proves WHO is driving the Home UI. It does NOT authorize the publication or grant —
 * their own signatures do, verified on-chain by the Workers. Requiring a session here is an
 * anti-abuse measure on the operator token, not an authority check.
 */
export async function handleResolution(
  ctx: FnContext,
  token: string | undefined,
  payload: ResolutionAction,
): Promise<{ status: number; body: unknown }> {
  const env = ctx.env as FnContext['env'] & ResolutionEnv;
  const cfg = resolutionConfig(env);
  if (!cfg) {
    return {
      status: 503,
      body: {
        ok: false,
        error: 'not_configured',
        detail: 'PUBLICATIONS_URL / RESOLVER_URL / PUBLISH_TOKEN / ISSUE_TOKEN are required on the Home.',
      },
    };
  }

  // Reads are safe for any caller that knows the channel id (the id IS the capability, spec 338 §9),
  // so they do not consume an operator token and need no session.
  if (payload.action === 'read') {
    return forward(
      `${cfg.publicationsUrl}/v1/publications?channelId=${encodeURIComponent(payload.channelId)}`,
      { method: 'GET' },
    );
  }

  // Everything below spends an operator token — require a live Home session.
  if (!token) return { status: 401, body: { ok: false, error: 'unauthorized' } };
  try {
    const { jwks } = await getServer(env);
    const keys = await importJwks(jwks);
    const v = await verifyAgentSession(token, {
      keys,
      expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso',
      expectedIss: ownIssuer(ctx.request, env),
    });
    if (!v.ok) return { status: 401, body: { ok: false, error: 'unauthorized' } };
  } catch {
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }

  const json = (t: string, b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify(b),
  });

  switch (payload.action) {
    case 'publish':
      // Already signed by the principal. The Worker re-verifies on-chain before storing.
      return forward(`${cfg.publicationsUrl}/v1/publications`, json(cfg.publishToken, payload.publication));

    case 'issue':
      // Already signed by the ISSUER over `grantBody()`. The Worker verifies that signature on-chain,
      // and — when the grant's signed `authorityRef` commits to one — re-hashes the delegation and
      // checks its caveats, revocation and signature too. The operator token only gates the write.
      return forward(
        `${cfg.resolverUrl}/v1/private/grants`,
        json(cfg.issueToken, { grant: payload.grant, delegation: payload.delegation }),
      );

    case 'revoke':
      return forward(
        `${cfg.resolverUrl}/v1/private/grants/revoke`,
        json(cfg.issueToken, { grantId: payload.grantId }),
      );

    default:
      return { status: 400, body: { ok: false, error: 'malformed' } };
  }
}

// ─── Route adapters (mirrors the other connect routes) ──────────────────────

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const bearer = (request: Request): string | undefined =>
  request.headers.get('authorization')?.replace(/^Bearer /i, '') || undefined;

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: CORS });

/** GET ?channelId=… — a read; the channel id is itself the capability (spec 338 §9). */
export async function onRequestGet(ctx: FnContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const channelId = url.searchParams.get('channelId') ?? '';
  const { status, body } = await handleResolution(ctx, undefined, { action: 'read', channelId });
  return Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}

/** POST { action:'publish'|'issue'|'revoke', … } — spends an operator token, so it needs a session. */
export async function onRequestPost(ctx: FnContext): Promise<Response> {
  let payload: ResolutionAction;
  try {
    payload = (await ctx.request.json()) as ResolutionAction;
  } catch {
    return Response.json({ ok: false, error: 'malformed' }, { status: 400, headers: CORS });
  }
  const { status, body } = await handleResolution(ctx, bearer(ctx.request), payload);
  return Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}
