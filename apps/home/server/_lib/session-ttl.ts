// HOW LONG A SESSION LASTS — one definition, read by both mint paths.
//
// The id_token IS the session for relying apps (they store it and present it as a bearer). Two
// places mint one — the /token code exchange and the /oidc/grant ceremony — and when they disagree
// the lifetime you get depends on which route you arrived through, which is not a thing anyone can
// reason about. So the value lives here and both import it.
//
// It is configurable because the right answer differs by deployment: a development instance wants a
// session that outlives a working session, a production one wants the exposure window short. A
// bearer token with no revocation path is valid for its whole life to whoever holds it.
import type { Env } from './server-broker';
import { whitelabel } from '../../src/whitelabel/config';

/** 7 days. Long enough that a working session is not interrupted; short enough to bound a leak. */
export const SESSION_TTL_DEFAULT = 604_800;

/** Floor of 60s and a ceiling of 30 days: a typo of "60000" days is a mistake, not a policy, and a
 *  sub-minute token would expire between minting and first use. */
const MIN = 60;
const MAX = 2_592_000;

/** The lifetime for a token minted for `clientId`: the client's own `session_ttl_seconds` when its registration
 *  declares one (an app whose people read for days — the Seed Bible reader — asks for days, while the estate's
 *  setting stays what it is for every other app), else the deployment's, else the default. Same floor and ceiling. */
export function idTokenTtl(env: Pick<Env, 'ID_TOKEN_TTL_SECONDS'>, clientId?: string | null): number {
  const raw = Number(clientSessionTtl(clientId) ?? env.ID_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return SESSION_TTL_DEFAULT;
  return Math.min(MAX, Math.max(MIN, Math.floor(raw)));
}

/** The app's own sign-in lifetime, when its registration declares one (bounded); null when it does not. */
export function clientSessionTtl(clientId?: string | null): number | null {
  const own = clientId ? whitelabel.relyingApps.find((a) => a.client_id === clientId)?.session_ttl_seconds : undefined;
  if (own === undefined || !Number.isFinite(own) || own <= 0) return null;
  return Math.min(MAX, Math.max(MIN, Math.floor(own)));
}
