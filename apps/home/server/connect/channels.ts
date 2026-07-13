// /connect/channels — PROXY to the org's InteractionsDO (spec 322 W2.3b). The Home no longer
// gates, mutates, or persists channel state: every board operation forwards to the per-principal
// serialized execution point on demo-a2a (`/interactions/<org>/<op>`), which owns the membership
// gate (gate-time ERC-1271 listing re-verification), the steward proof, the audit, and the vault
// writes over the plane-B interactions grant. This route keeps ONLY: session extraction (the DO
// re-verifies it against the broker JWKS), the steward-wire attach (from the person's org link),
// the member-link projection reconcile (a Home-local cache), and response-shape compatibility for
// the existing UI. It retires entirely at W5 (spec 322 §5).
//
// Wire shapes preserved for the UI:
//   GET  ?communityId=…[&channelId=…] → { channels, bodies?, you, orgVaultEnabled, membership, steward }
//   POST { action:'create'|'post', … } → { ok, channelId?|messageId? } | { error }
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { ensureOrgMemberLink } from './membership';
import { orgVault } from '../lib/org-vault';

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

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

const a2aBase = (env: FnContext['env']): string | undefined =>
  (env as { A2A_CUSTODY_URL?: string }).A2A_CUSTODY_URL?.replace(/\/$/, '') || undefined;

/** The steward's org→person stewardship wire from their org link — the DO's steward proof. */
export async function stewardWireFor(env: FnContext['env'], person: string, org: string): Promise<unknown | null> {
  const raw = await env.AUTH_CODES.get(`related:${person}:${org}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string; stewardshipDelegation?: unknown }) : null;
  return link && link.relationship !== 'member' ? (link.stewardshipDelegation ?? null) : null;
}

/** The org→person MEMBER-ACCESS wire (SEC-H1) — the ORG's authorization that `person` may join,
 *  minted by the steward at invite time and stored in the org vault at `org.invite:agent:<person>`.
 *  The DO re-verifies it on-chain (ERC-1271 by the org + unrevoked + data-grant scope), so the
 *  SOURCE is untrusted — this only has to FIND the artifact. Falls back to the member's own KV link
 *  (populated after the first join) when the org vault isn't reachable. */
export async function memberAccessWireFor(env: FnContext['env'], org: string, person: string): Promise<unknown | null> {
  try {
    const vault = await orgVault(env, org);
    const rec = vault ? ((await vault.get(`org.invite:agent:${person.toLowerCase()}`)) as { delegation?: unknown; status?: string } | null) : null;
    if (rec?.delegation && rec.status !== 'removed') return rec.delegation;
  } catch { /* vault unreachable — fall to the cached link */ }
  const raw = await env.AUTH_CODES.get(`related:${person.toLowerCase()}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { memberAccessDelegation?: unknown }) : null;
  return link?.memberAccessDelegation ?? null;
}

/** Forward one op to the org's InteractionsDO (fail-closed: no base ⇒ 503, never a local fallback). */
export async function callInteractions(
  env: FnContext['env'],
  org: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = a2aBase(env);
  if (!base) return { status: 503, body: { error: 'interactions execution point not configured' } };
  const res = await fetch(`${base}/interactions/${org.toLowerCase()}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  const communityId = (url.searchParams.get('communityId') ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
  void resolveOrigin;

  const channelId = url.searchParams.get('channelId');
  const stewardship = await stewardWireFor(env, who.person, communityId);
  const r = await callInteractions(env, communityId, channelId ? 'channels.read' : 'channels.list', {
    session: who.token,
    ...(channelId ? { channelId } : {}),
    ...(stewardship ? { stewardship } : {}),
  });
  if (r.status === 409) {
    // 409 has TWO meanings and the UI must tell them apart (no more silent "empty" — the storage is
    // not simply "off"): (a) NO grant yet → first-time Enable; (b) grant STALE because a wave widened
    // the interactions scope → the steward must RE-Enable to re-sign. Both route to the Enable banner,
    // but a stale grant surfaces its reason so the steward knows why an org that "worked" needs it.
    const reason = String((r.body as { error?: string }).error ?? '');
    const stale = /stale/i.test(reason);
    return jsonCors({ channels: [], bodies: {}, you: '', orgVaultEnabled: false, needsReEnable: stale, reason, membership: 'linked', steward: !!stewardship }, request);
  }
  if (r.status !== 200) return jsonCors(r.body, request, r.status);

  // Membership projection reconcile (Home-local cache; the DO just proved the listing).
  let membership: 'linked' | `link-failed: ${string}` = 'linked';
  if (r.body.you && r.body.you !== 'Steward') {
    try { await ensureOrgMemberLink(env, who.person, communityId); }
    catch (e) { membership = `link-failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  return jsonCors({ ...r.body, orgVaultEnabled: true, membership, steward: r.body.steward === true || !!stewardship }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; communityId?: string; channelId?: string; title?: string; bodyText?: string; visibility?: 'public' | 'private'; members?: string[] }
    | null;
  const communityId = (body?.communityId ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);

  const stewardship = await stewardWireFor(env, who.person, communityId);
  if (body?.action === 'create') {
    const r = await callInteractions(env, communityId, 'channels.create', {
      session: who.token, title: body.title ?? '',
      // spec 324 §10 — public (default) or private-to-selected-members topic.
      ...(body.visibility === 'private' ? { visibility: 'private', members: Array.isArray(body.members) ? body.members : [] } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  if (body?.action === 'post') {
    const r = await callInteractions(env, communityId, 'channels.post', {
      session: who.token, channelId: body.channelId ?? '', bodyText: body.bodyText ?? '',
    });
    return jsonCors(r.body, request, r.status);
  }
  return jsonCors({ error: 'unknown action' }, request, 400);
};
