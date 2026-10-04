// POST /connect/workspace-invite — the P4 membership handoff between two Home ceremonies.
//
// A workspace member's vault access is a `workspace → member` delegation only the CUSTODIAN's
// credential can sign, but only the MEMBER's session may write the member's own related-agent
// link. So the grant travels through a single-use stash:
//
//   invite leg (custodian session):  sign the grant in the `workspace-member-invite` ceremony,
//                                    stash it here keyed (workspace, member).
//   join leg   (member session):     `workspace-join` claims the stash — single use — and writes
//                                    the member's own link via /connect/related-orgs.
//
// The stash carries NO authority of its own: the delegation inside it is custodian-signed and
// verified where it is used (the vault), and the roster in the workspace vault still gates every
// call the relying app makes. Losing this KV loses pending invitations, nothing else.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}

function jsonCors(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** Pending invitations are an offer, not a standing state — a week unclaimed, they expire. */
const INVITE_TTL_SECONDS = 7 * 24 * 3600;

async function sessionPersonOf(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer) return null;
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(bearer, { keys, expectedAud: homeAud, expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as {
    workspace?: string;
    member?: string;
    /** Custodian leg: the signed `workspace → member` delegation (wire form). */
    delegation?: unknown;
    /** Custodian leg: the record-covering MEMBERSHIP wire (P4) — stashed beside the site grant. */
    membership?: unknown;
    workspaceName?: string;
    /** Custodian leg, GOVERNED workspace (2026-10-02): the organization that governs it, the org→member access
     *  grant and the organization's signed half of the has-member credential — the same artifacts
     *  `/connect/org-invite/agent` just recorded, carried here so the member's join records the membership on
     *  the governor and countersigns. Absent for a legacy workspace. Opaque: verified where they are used. */
    governor?: string;
    governorName?: string;
    governorAccess?: unknown;
    relationshipOffer?: unknown;
    /** Member leg: claim (and consume) the pending invitation addressed to the session's person. */
    claim?: boolean;
  } | null;
  const workspace = (body?.workspace ?? '').toLowerCase();
  if (!ADDRESS.test(workspace)) return jsonCors({ error: 'workspace (0x…40) required' }, request, 400);

  const person = await sessionPersonOf(request, env);
  if (!person) return jsonCors({ error: 'a Home session is required' }, request, 401);
  const key = (member: string) => `wsinvite:${workspace}:${member}`;

  if (body?.claim) {
    // MEMBER leg — the session's person claims their own invitation. Single use: the stash is
    // deleted on read, so a leaked claim response cannot be replayed into a second link.
    const raw = await env.AUTH_CODES.get(key(person));
    if (!raw) {
      return jsonCors(
        { error: 'Home holds no invitation for you at this workspace — it may have been used already, or sent before access signing. Ask the person who invited you to send it again.' },
        request,
        404,
      );
    }
    await env.AUTH_CODES.delete(key(person));
    return jsonCors({ ok: true, invite: JSON.parse(raw) }, request);
  }

  // CUSTODIAN leg — stash a signed grant for a named member. The signer must actually govern
  // this workspace: their own related-agent link to it, relationship steward.
  const member = (body?.member ?? '').toLowerCase();
  if (!ADDRESS.test(member)) return jsonCors({ error: 'member (0x…40) required' }, request, 400);
  if (!body?.delegation || typeof body.delegation !== 'object') {
    return jsonCors({ error: 'delegation (wire form) required' }, request, 400);
  }
  const linkRaw = await env.AUTH_CODES.get(`related:${person}:${workspace}`);
  const link = linkRaw ? (JSON.parse(linkRaw) as { relationship?: string }) : null;
  if (!link || (link.relationship ?? 'steward') !== 'steward') {
    return jsonCors({ error: 'only a steward of this workspace may invite into it' }, request, 403);
  }
  await env.AUTH_CODES.put(
    key(member),
    JSON.stringify({
      workspace,
      member,
      delegation: body.delegation,
      membership: body.membership ?? null,
      workspaceName: body.workspaceName ?? '',
      ...(typeof body.governor === 'string' && ADDRESS.test(body.governor.toLowerCase())
        ? { governor: body.governor.toLowerCase(), governorName: body.governorName ?? '', governorAccess: body.governorAccess ?? null, relationshipOffer: body.relationshipOffer ?? null }
        : {}),
      invitedBy: person,
      createdAt: Date.now(),
    }),
    { expirationTtl: INVITE_TTL_SECONDS },
  );
  return jsonCors({ ok: true }, request);
};
