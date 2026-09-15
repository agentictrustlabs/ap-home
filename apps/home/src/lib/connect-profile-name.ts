'use client';
// The member's HUMAN name, read for a connect that is permitted to receive it.
//
// The name lives in the member's own encrypted vault (`vault:impact-profile`, sealed under their
// KEK), which means the BROKER CANNOT READ IT — `/oidc/grant` has a signed delegation and an
// address and no way to decrypt a profile. Only this page can, over the member's own session. So
// the home SPA reads it here and hands it to `/oidc/authorize-grant`, which re-checks the client's
// registered `profile` scope before storing it. Two gates, one on each side of the wire.
//
// NOT the `<label>.me` handle. That is a globally-unique on-chain name in the naming service and
// claiming one is a separate, deliberate act; accounts created at first connect stay nameless there
// by design. This is the name a person is CALLED, and it is the only reason a card table can label
// a seat instead of rendering `0x1a2b…9f0e`.
//
// BEST-EFFORT, ALWAYS. Every failure — no session, an unbound vault key, a slow round trip — yields
// '' and the connect proceeds exactly as it does today. A name is worth one screen of setup; it is
// not worth a sign-in.
import { fetchProfile } from '../connect-client';
import { SESSION_KEY } from '../context/session';
import { readSsoCookie } from './sso-cookie';
import { loadImpactProfile } from '../profile-store';
import { personDisplayName } from './new-member';

/** Ceiling on the whole lookup. Two round trips sit on the critical path of a connect the member is
 *  watching, so a slow vault costs them a nameless seat rather than a stalled sign-in. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** The home-session bearer for THIS browser — same order the profile store uses (per-origin
 *  localStorage first, then the parent-domain SSO cookie). */
function homeToken(): string {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const t = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    if (t) return t;
  } catch { /* storage blocked — fall through to the cookie */ }
  return readSsoCookie()?.token ?? '';
}

/** What one vault read yields. Either field may be '' — neither is required to sign in. */
export interface ConnectProfile {
  readonly name: string;
  readonly email: string;
}

const NOTHING: ConnectProfile = { name: '', email: '' };

async function read(): Promise<ConnectProfile> {
  const token = homeToken();
  if (!token) return NOTHING;
  const profile = await fetchProfile(token);
  const addr = profile?.agent?.split(':').pop();
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return NOTHING;
  const stored = await loadImpactProfile(addr as `0x${string}`);
  return { name: personDisplayName(stored.contact), email: (stored.contact?.email ?? '').trim().toLowerCase() };
}

/**
 * The member's name and verified email, as far as this browser can read them. ONE read for both —
 * they live in the same vault record, and the caller gates each field separately against what the
 * client is registered for.
 *
 * Absent fields are normal, not an error: the email is seeded best-effort at sign-in and a member
 * whose vault key bind has not landed simply has none. Same rule as the name — worth one screen of
 * setup, never worth a sign-in.
 */
export async function profileForConnect(): Promise<ConnectProfile> {
  try {
    return await Promise.race([
      read(),
      new Promise<ConnectProfile>((resolve) => setTimeout(() => resolve(NOTHING), LOOKUP_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn('[connect] profile unavailable — connecting without it:', e);
    return NOTHING;
  }
}
