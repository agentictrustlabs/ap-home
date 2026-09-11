// /connect/app-grants — spec 397 W4. The apps a PERSON authorized with their own wire (the Home MCP's `ask-as-me`
// above all): what each may do, since when, and the wire itself so the person can revoke it ON CHAIN from here.
// Authorized by the Home session only (like /connect/apps): this is the surface that lists a person's own grants.
//   GET             → { ok, grants: [{ clientId, appName, template, delegate, delegation, issuedAt, validUntil }] }
//   POST { clientId, revoked: true } → forget the row after the person revoked the wire on chain (the chain is
//   the record; a row for a revoked wire is a stale pointer).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { getClient } from '../../src/lib/oidc-clients';
import { CONTRACTS } from '../../src/lib/chain';

const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const v = await verifyAgentSession(token, { keys: await importJwks(jwks), expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

interface Row { clientId: string; template: string; delegate: string; delegation: { caveats?: Array<{ enforcer: string; terms: string }> }; issuedAt: number }

/** The timestamp caveat's validUntil, read from the wire's own terms (uint128 validAfter ‖ uint128 validUntil). */
function validUntilOf(row: Row, timestampEnforcer: string | undefined): number | null {
  const c = (row.delegation.caveats ?? []).find((x) => timestampEnforcer && x.enforcer.toLowerCase() === timestampEnforcer.toLowerCase());
  if (!c || typeof c.terms !== 'string' || c.terms.length < 66) return null;
  const hex = c.terms.slice(2);
  const until = Number(BigInt('0x' + hex.slice(32, 64)));
  return Number.isFinite(until) && until > 0 ? until * 1000 : null;
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const rows = JSON.parse((await env.AUTH_CODES.get(`app-grants:${person}`)) ?? '[]') as Row[];
  return json({ ok: true, grants: rows.map((r) => ({ ...r, appName: getClient(r.clientId)?.name ?? r.clientId, validUntil: validUntilOf(r, CONTRACTS.timestampEnforcer) })) });
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const body = (await request.json().catch(() => null)) as { clientId?: string; revoked?: boolean } | null;
  if (!body?.clientId || body.revoked !== true) return json({ error: 'clientId and revoked: true are required' }, 400);
  const key = `app-grants:${person}`;
  const rows = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as Row[];
  await env.AUTH_CODES.put(key, JSON.stringify(rows.filter((r) => r.clientId !== body.clientId)));
  return json({ ok: true });
};
