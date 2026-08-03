// Verify an id_token THIS Home minted for a registered relying client.
//
// Extracted from `connect/inbox.ts`, where it already gated the inbox read/write surface, so that
// `connect/inbox/deliver` can apply the SAME check. It was previously the only authenticated path into
// a person's inbox; `deliver` had none at all (spec 341 §5.2).
//
// WHAT THIS PROVES, and what it does not. It proves the caller holds a token this Home issued, to a
// registered client, for a particular subject — so a claimed sender can be bound to a verified one. It
// proves NOTHING about authority: holding an id_token is not permission to do anything, and every
// authority gate downstream still runs (ADR-0041).

import { importJwks, verifyIdToken } from '@agenticprimitives/connect';
import { getClient } from '../../src/lib/oidc-clients';

/**
 * Returns the subject SA (lowercased) or `null`.
 *
 * The SIGNATURE check against our own JWKS is what authenticates; `iss`/`aud` are gates on what we are
 * willing to accept. `iss` and `aud` are peeked UNVERIFIED first only to choose what to check against —
 * `verifyIdToken` compares them by strict equality, so a forged token cannot widen anything by claiming
 * a different issuer: it would still have to be signed by our keys.
 */
export async function verifyRelyingClientIdToken(
  token: string,
  keys: Awaited<ReturnType<typeof importJwks>>,
  isOwnIss: (iss: string) => boolean,
): Promise<string | null> {
  let iss: string | undefined;
  let aud: string | undefined;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')),
          (c) => c.charCodeAt(0),
        ),
      ),
    ) as { iss?: string; aud?: string };
    iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  } catch {
    return null;
  }
  if (!iss || !isOwnIss(iss) || !aud || !getClient(aud)) return null;
  const r = await verifyIdToken(token, { keys, expectedIss: iss, expectedAud: aud });
  if (!r.ok) return null;
  const sub = (r.claims.canonical_agent_id ?? r.claims.sub ?? '') as string;
  return (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(request: Request): string {
  const auth = request.headers.get('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
