// THE PERSON BEHIND A BEARER — a Home session, or an id_token this Home minted for a registered relying app (the
// app's sign-in: the reader holds one, never a Home session). Either names the person's smart agent; what that
// person may then do is still each endpoint's (and the agent's) to decide.
import { importJwks, verifyAgentSession, verifyIdToken } from '@agenticprimitives/connect';
import { getServer, ownIssuer, type FnContext } from './server-broker';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient } from './oidc-registry';

export interface BearerPerson {
  /** The person's agent address, lowercased. */
  person: string;
  token: string;
  /** `session` — a Home session (it can sign mail as them); `app` — a relying app's id_token, and which app. */
  via: 'session' | 'app';
  client?: string;
}

export async function personFromBearer(request: Request, env: FnContext['env']): Promise<BearerPerson | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (v.ok) {
    const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
    return person ? { person, token, via: 'session' } : null;
  }
  const person = await verifyIdTokenForRelyingClient(env, token, keys, ownIssuer(request, env));
  if (!person) return null;
  return { person, token, via: 'app', client: audOf(token) ?? undefined };
}

function audOf(token: string): string | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { aud?: string };
    return typeof payload.aud === 'string' ? payload.aud : null;
  } catch { return null; }
}

/** Verify `token` as an id_token this Home minted for a REGISTERED relying client. The SIGNATURE is checked
 *  against our own JWKS (the real proof it's ours); iss is gated by the same `ownIssuer` predicate the
 *  session path uses (accepts apex/www/subdomain forms); aud must be a registered client_id. Returns the
 *  subject SA (lowercased) or null. */
export async function verifyIdTokenForRelyingClient(
  // `env` reaches the CLIENT REGISTRY — curated entries plus the member-registered ones, which
  // live in KV and therefore need the binding rather than a compiled-in table.
  env: FnContext['env'],
  token: string,
  keys: Awaited<ReturnType<typeof importJwks>>,
  isOwnIss: (iss: string) => boolean,
): Promise<string | null> {
  // Peek the unverified iss + aud, gate them cheaply, THEN verify (signature/iss/aud/exp) against exactly
  // those values. verifyIdToken's iss/aud checks are strict-equality, so we pass the peeked values — the
  // signature check against our JWKS is what actually authenticates; the gates constrain what we accept.
  let iss: string | undefined, aud: string | undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { iss?: string; aud?: string };
    iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  } catch { return null; }
  if (!iss || !isOwnIss(iss) || !aud || !(await resolveClient(env, aud))) return null;
  const r = await verifyIdToken(token, { keys, expectedIss: iss, expectedAud: aud });
  if (!r.ok) return null;
  const sub = (r.claims.canonical_agent_id ?? r.claims.sub ?? '') as string;
  return (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

