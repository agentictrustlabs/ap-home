// /connect/app-grants — spec 397 W4. The apps a PERSON authorized with their own wire (the Home MCP's `ask-as-me`
// above all): what each may do, since when, and the wire itself so the person can revoke it ON CHAIN from here.
// Authorized by the Home session only (like /connect/apps): this is the surface that lists a person's own grants.
//   GET             → { ok, grants: [{ clientId, appName, template, delegate, delegation, issuedAt, validUntil }] }
//   POST { clientId, revoked: true } → forget the row after the person revoked the wire on chain (the chain is
//   the record; a row for a revoked wire is a stale pointer).
//   POST { clientId, delegation } → REPLACE the row's wire after a credential rotation re-issued it (spec 410 §1.2:
//   same terms, same salt, the account's approved-digest sentinel). The row stays a pointer; the lineage record in
//   the person's vault is what the delegate's refresh reads.
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

interface ActWire { v: 1; template: string; capability: string; wire: { delegator?: string; delegate?: string; caveats?: Array<{ enforcer: string; terms: string }> }; ref: string; requirement: Record<string, unknown> }
interface Row { clientId: string; template: string; delegate: string; delegation: { caveats?: Array<{ enforcer: string; terms: string }> }; issuedAt: number; /** Spec 397 §11 — the act set, one wire per capability. */ wires?: ActWire[] }

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
  return json({ ok: true, grants: rows.map((r) => ({ ...r, appName: getClient(r.clientId)?.name ?? r.clientId, validUntil: validUntilOf(r, CONTRACTS.timestampEnforcer), ...(r.wires ? { wires: r.wires.map((w) => ({ ...w, validUntil: validUntilOf({ ...r, delegation: w.wire }, CONTRACTS.timestampEnforcer) })) } : {}) })) });
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return json({ error: 'session required' }, 401);
  const body = (await request.json().catch(() => null)) as { clientId?: string; revoked?: boolean; ref?: string; delegation?: Row['delegation'] & { delegator?: string; delegate?: string; signature?: string } } | null;
  if (!body?.clientId) return json({ error: 'clientId is required' }, 400);
  const key = `app-grants:${person}`;
  const rows = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as Row[];
  // Spec 397 §11 — ONE act wire, by its ref: forgotten after she revoked it on chain, or re-pointed at its re-issued
  // twin after a rotation (same delegator and delegate; the ref moves with the signature scheme, the capability stays).
  if (typeof body.ref === 'string' && body.ref) {
    const row = rows.find((r) => r.clientId === body.clientId);
    const w = row?.wires?.find((x) => x.ref.toLowerCase() === body.ref!.toLowerCase());
    if (!row || !w) return json({ error: 'no act wire with that ref' }, 404);
    if (body.revoked === true) {
      const wires = row.wires!.filter((x) => x.ref.toLowerCase() !== body.ref!.toLowerCase());
      await env.AUTH_CODES.put(key, JSON.stringify(rows.map((r) => (r.clientId === body.clientId ? { ...r, wires } : r))));
      return json({ ok: true, remaining: wires.length });
    }
    const rep = body.delegation as (Row['delegation'] & { delegator?: string; delegate?: string }) | undefined;
    const nextRef = typeof (body as { nextRef?: unknown }).nextRef === 'string' ? (body as { nextRef: string }).nextRef : '';
    if (!rep || !nextRef) return json({ error: 'revoked: true, or a replacement delegation with its nextRef, is required' }, 400);
    if (String(rep.delegator ?? '').toLowerCase() !== String(w.wire.delegator ?? '').toLowerCase() || String(rep.delegate ?? '').toLowerCase() !== String(w.wire.delegate ?? '').toLowerCase()) return json({ error: 'the replacement must be the same wire re-issued (same delegator and delegate)' }, 400);
    const wires = row.wires!.map((x) => (x.ref.toLowerCase() === body.ref!.toLowerCase() ? { ...x, wire: rep, ref: nextRef } : x));
    await env.AUTH_CODES.put(key, JSON.stringify(rows.map((r) => (r.clientId === body.clientId ? { ...r, wires } : r))));
    return json({ ok: true, replaced: true });
  }
  if (body.revoked === true) {
    await env.AUTH_CODES.put(key, JSON.stringify(rows.filter((r) => r.clientId !== body.clientId)));
    return json({ ok: true });
  }
  if (body.delegation && typeof body.delegation === 'object') {
    const row = rows.find((r) => r.clientId === body.clientId);
    if (!row) return json({ error: 'no grant row for that client' }, 404);
    // The replacement is the SAME wire re-issued: same delegator (this person), same delegate; only the signature
    // (now the sentinel) may differ. Anything else is a new grant, which is not what this door is for.
    if (String(body.delegation.delegator ?? '').toLowerCase() !== person || String(body.delegation.delegate ?? '').toLowerCase() !== String(row.delegate).toLowerCase()) return json({ error: 'the replacement must be the same wire re-issued (same delegator and delegate)' }, 400);
    await env.AUTH_CODES.put(key, JSON.stringify(rows.map((r) => (r.clientId === body.clientId ? { ...r, delegation: body.delegation } : r))));
    return json({ ok: true, replaced: true });
  }
  return json({ error: 'revoked: true or a replacement delegation is required' }, 400);
};
