// GET/POST /connect/self-grant?purpose=<p>  (spec 345 + spec 347 §9)
//
// The person's OWN scoped vault grant — `delegator = delegate = personSA` — held for them between
// visits so a read-only screen does not ask for a signature every time it loads.
//
// This store exists because the alternative is worse in two specific ways. Keeping the grant only in the
// browser means a device prompt on every visit ("value steps ≠ signatures"). Parking it in the
// related-orgs index — the other obvious place, since that is where stewardship delegations live — is the
// exact bug spec 345 §0 was written about: the person's own address starts reading as an org they steward
// and shows up in their own org list. So: its own namespace, and a person is never an org here.
//
// WHAT IS CHECKED BEFORE ANYTHING IS STORED (all fail-closed, in order):
//   1. the session is a valid home session, and its `sub` names the person;
//   2. the grant's delegator AND delegate are BOTH that person — a grant to anyone else is not a
//      self-grant and is refused, whatever it is;
//   3. the grant is signature-valid on chain (ERC-1271 via the shared verifier) — we store proof, not
//      an assertion;
//   4. it carries a vault-record-scope caveat, and every resource in it is inside the purpose's
//      allow-list. This is the one that matters: without it this endpoint would be a way to park a
//      full-vault self-delegation and have the Home hand it back on request.
// A stored grant is returned only while its own timestamp caveat still covers now.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { decodeTimestampTerms, decodeVaultRecordScopeTerms, VAULT_RECORD_SCOPE_ENFORCER } from '@agenticprimitives/delegation';
import type { Hex } from 'viem';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { verifyDelegation, type IncomingDelegation } from '../_lib/verify-delegation';
import { CONTRACTS } from '../../src/lib/chain';

/** What each purpose is ALLOWED to cover. A grant asking for anything outside its purpose's families is
 *  refused — the purpose names the screen, and the screen's record families are not negotiable by the
 *  caller. `agent-card-studio` mirrors STUDIO_VAULT_SCOPE in src/lib/studio-self-grant.ts. */
export const PURPOSE_RESOURCES: Record<string, readonly string[]> = {
  'agent-card-studio': ['vault:agent-cards:*', 'vault:projections:*', 'vault:bindings:*', 'vault:approvals:*'],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const key = (person: string, purpose: string): string => `self-grant:${purpose}:${person.toLowerCase()}`;

/** The person this session speaks for, or null. */
async function personOf(request: Request, env: FnContext['env']): Promise<string | null> {
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
  return v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0]?.toLowerCase() ?? null;
}

/** `validUntil` from the grant's own timestamp caveat (seconds); 0 when it carries none. */
export function validUntilOf(d: IncomingDelegation): number {
  const c = d.caveats.find((x) => x.enforcer.toLowerCase() === (CONTRACTS.timestampEnforcer as string).toLowerCase());
  if (!c) return 0;
  try {
    return Number(decodeTimestampTerms(c.terms as Hex).validUntil);
  } catch {
    return 0;
  }
}

/** Is every resource this grant claims inside what the purpose allows? An unscoped grant (no caveat) is
 *  NOT acceptable here: demo-mcp treats a missing caveat as inert, which means whole-vault. */
export function withinPurpose(d: IncomingDelegation, allowed: readonly string[]): boolean {
  const c = d.caveats.find((x) => x.enforcer.toLowerCase() === VAULT_RECORD_SCOPE_ENFORCER.toLowerCase());
  if (!c) return false;
  try {
    const grants = decodeVaultRecordScopeTerms(c.terms as Hex);
    if (grants.length === 0) return false;
    return grants.every((g) => g.resources.length > 0 && g.resources.every((r) => allowed.includes(r)));
  } catch {
    return false;
  }
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const purpose = new URL(request.url).searchParams.get('purpose') ?? '';
  if (!PURPOSE_RESOURCES[purpose]) return json({ error: 'unknown purpose' }, 400);
  const person = await personOf(request, env);
  if (!person) return json({ error: 'sign in first' }, 401);

  const raw = await env.AUTH_CODES.get(key(person, purpose));
  if (!raw) return json({ grant: null });
  const stored = JSON.parse(raw) as { grant: IncomingDelegation; validUntil: number };
  // Expiry is re-derived from the grant itself, never trusted from the row.
  if (validUntilOf(stored.grant) <= Math.floor(Date.now() / 1000)) return json({ grant: null });
  return json({ grant: stored.grant });
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const purpose = new URL(request.url).searchParams.get('purpose') ?? '';
  const allowed = PURPOSE_RESOURCES[purpose];
  if (!allowed) return json({ error: 'unknown purpose' }, 400);
  const person = await personOf(request, env);
  if (!person) return json({ error: 'sign in first' }, 401);

  const body = (await request.json().catch(() => null)) as { grant?: IncomingDelegation } | null;
  const grant = body?.grant;
  if (!grant?.delegator || !grant.delegate || !Array.isArray(grant.caveats)) return json({ error: 'grant required' }, 400);

  // A self-grant is the person on BOTH sides. Anything else is some other relationship wearing this
  // endpoint's name, and this is the guard whose absence spec 345 §0 documents.
  if (grant.delegator.toLowerCase() !== person || grant.delegate.toLowerCase() !== person) {
    return json({ error: 'a self grant must be the signed-in person on both sides' }, 401);
  }
  if (!withinPurpose(grant, allowed)) {
    return json({ error: `grant must be scoped to ${purpose}'s record families` }, 400);
  }
  const validUntil = validUntilOf(grant);
  if (validUntil <= Math.floor(Date.now() / 1000)) return json({ error: 'grant is already expired' }, 400);

  const v = await verifyDelegation(env, grant);
  if (!v.ok) return json({ error: `grant proof failed: ${v.reason}` }, 401);

  await env.AUTH_CODES.put(key(person, purpose), JSON.stringify({ grant, validUntil }));
  return json({ ok: true });
};
