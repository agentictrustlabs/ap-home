// /connect/inbox/delivery-grant  (spec 317 §3.2 / W2) — the standing INBOX-DELIVERY delegation store.
//
// The recipient signs ONE delegation at onboarding authorizing the Home's delivery-service SA to WRITE
// message bodies into the recipient's vault (residency, W3). This endpoint persists it, keyed by the
// recipient, so the (server-side) delivery path can retrieve + present it later.
//
//   GET  ?owner=<sa>      → { stored: boolean }   (idempotency check for onboarding)
//   POST { owner, delegation } → { ok, stored }   (persist the signed grant)
//
// AUTH: session-gated (the person's Bearer id_token), owner MUST equal the session principal — so no one
// can overwrite a victim's grant with a junk delegation (a delivery-DoS vector). The delegation's own
// signature is the AUTHORITY at redemption (demo-mcp ERC-1271-verifies + record-scope-gates it, spec 317
// §3.2); this endpoint only decides WHO may store WHOSE grant. Structural checks fail closed.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, type FnContext } from '../_lib/server-broker';
import { VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';

/** KV key for a recipient's stored inbox-delivery grant (the signed delegation wire). */
const GRANT_KEY = (owner: string): string => `inbox-delivery-grant:${owner.toLowerCase()}`;

interface DelegationWireLike {
  delegator?: string;
  delegate?: string;
  caveats?: Array<{ enforcer?: string }>;
  signature?: string;
}

/** Server-internal loader for the delivery path (W3). Returns the stored delegation wire, or null. */
export async function loadInboxDeliveryGrant(
  env: { AUTH_CODES: { get(k: string): Promise<string | null> } },
  recipient: string,
): Promise<DelegationWireLike | null> {
  const raw = await env.AUTH_CODES.get(GRANT_KEY(recipient));
  return raw ? (JSON.parse(raw) as DelegationWireLike) : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Recover the session principal (person SA) from the Bearer id_token, or null. */
async function sessionPerson(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const url = new URL(request.url);
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('id_token') ?? '';
  if (!token) return null;
  const iss = resolveOrigin(request, env);
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: homeAud, expectedIss: iss });
  if (!v.ok) return null;
  return v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await sessionPerson(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const owner = (new URL(request.url).searchParams.get('owner') ?? '').toLowerCase();
  if (!owner || owner !== person) return json({ error: 'owner must be the session principal' }, 403);
  return json({ stored: (await loadInboxDeliveryGrant(env, owner)) !== null });
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await sessionPerson(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const body = (await request.json().catch(() => null)) as { owner?: string; delegation?: DelegationWireLike } | null;
  const owner = (body?.owner ?? '').toLowerCase();
  const d = body?.delegation;
  if (!owner || !d) return json({ error: 'owner and delegation required' }, 400);
  if (owner !== person) return json({ error: 'owner must be the session principal' }, 403);
  // Structural fail-closed checks (the on-chain signature + record-scope are re-verified at redemption):
  if ((d.delegator ?? '').toLowerCase() !== owner) return json({ error: 'delegation delegator must be the owner' }, 400);
  if (!d.signature || d.signature === '0x') return json({ error: 'delegation must be signed' }, 400);
  const hasRecordScope = (d.caveats ?? []).some(
    (c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase(),
  );
  if (!hasRecordScope) return json({ error: 'delegation must carry a VAULT_RECORD_SCOPE caveat' }, 400);
  await env.AUTH_CODES.put(GRANT_KEY(owner), JSON.stringify(d));
  return json({ ok: true, stored: true });
};

export const onRequestOptions = async (_ctx: FnContext): Promise<Response> => new Response(null, { status: 204 });
