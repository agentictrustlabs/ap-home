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
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { VAULT_RECORD_SCOPE_ENFORCER, decodeVaultRecordScopeTerms } from '@agenticprimitives/delegation';
import { INBOX_DATA_RESOURCE_SCOPE, CHANNELS_DATA_RESOURCE_SCOPE } from '../../src/lib/delegation';

/** KV key for a recipient's stored inbox-delivery grant (the signed delegation wire). */
const GRANT_KEY = (owner: string): string => `inbox-delivery-grant:${owner.toLowerCase()}`;

interface DelegationWireLike {
  delegator?: string;
  delegate?: string;
  caveats?: Array<{ enforcer?: string; terms?: string }>;
  signature?: string;
}

/** spec 316 §11a — a grant is "current" only when its record-scope covers BOTH vault-resident documents:
 *  the personal inbox (`vault:inbox.data`) AND the org channel board (`vault:channels.data`), not just the
 *  message-body records. A grant signed before the cutover (message.body:* only), or after only the first
 *  cutover step (inbox.data but no channels.data), is STALE: `stored`/`orgVaultEnabled` report false so
 *  onboarding re-issues + the Home/channels UI prompts re-enable, and the owner re-signs the FULL widened
 *  grant. Requiring both keeps the person "enable" banner and the org "enable vault storage" prompt consistent
 *  with what a write actually needs — without it, a stale grant is kept and the doc write is record-scope-denied. */
export function grantCoversCurrentScope(d: DelegationWireLike | null): boolean {
  if (!d?.signature || d.signature === '0x') return false;
  const cav = (d.caveats ?? []).find(
    (c) => (c.enforcer ?? '').toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase(),
  );
  if (!cav?.terms) return false;
  try {
    const resources = new Set(decodeVaultRecordScopeTerms(cav.terms as `0x${string}`).flatMap((g) => g.resources));
    return resources.has(INBOX_DATA_RESOURCE_SCOPE) && resources.has(CHANNELS_DATA_RESOURCE_SCOPE);
  } catch {
    return false;
  }
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
  const v = await verifyAgentSession(token, { keys, expectedAud: homeAud, expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
}

/** May `person` store/read the grant for `owner`? Themselves, or a managed org/service SA they control —
 *  the SAME control set the inbox `?agent=` scope and the workspace switcher gate on (`related-idx:<person>`,
 *  spec 315 / ADR-0025). This is what lets a steward provision the ORG's grant so channel-post bodies land
 *  in the org's vault (spec 318). Fail-closed: uncontrolled owner → 403. */
async function controlsOwner(env: FnContext['env'], person: string, owner: string): Promise<boolean> {
  if (owner === person.toLowerCase()) return true;
  const kv = (env as { AUTH_CODES: { get(k: string): Promise<string | null> } }).AUTH_CODES;
  const idx = JSON.parse((await kv.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.some((a) => a.toLowerCase() === owner)) return false;
  // spec 318: relationship:'member' is authority-only — a member may NOT store the org's grants.
  const raw = await kv.get(`related:${person}:${owner}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string }) : null;
  return link?.relationship !== 'member';
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await sessionPerson(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const owner = (new URL(request.url).searchParams.get('owner') ?? '').toLowerCase();
  if (!owner || !(await controlsOwner(env, person, owner))) {
    return json({ error: 'owner must be the session principal or a managed agent' }, 403);
  }
  // "stored" ⇒ a CURRENT grant (covers `vault:inbox.data` + `vault:channels.data`, spec 316 §11a). A grant
  // missing either reports false so onboarding re-issues + the Home/channels UI prompts re-enable — the owner
  // re-signs the full widened scope.
  return json({ stored: grantCoversCurrentScope(await loadInboxDeliveryGrant(env, owner)) });
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await sessionPerson(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const body = (await request.json().catch(() => null)) as { owner?: string; delegation?: DelegationWireLike } | null;
  const owner = (body?.owner ?? '').toLowerCase();
  const d = body?.delegation;
  if (!owner || !d) return json({ error: 'owner and delegation required' }, 400);
  if (!(await controlsOwner(env, person, owner))) {
    return json({ error: 'owner must be the session principal or a managed agent' }, 403);
  }
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
