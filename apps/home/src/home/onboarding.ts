// The onboarding ACTIVITIES as first-class operations, named in the member's lexicon
// (docs/portal-lexicon.md). Each wraps the lower-level connect-client primitives so the flow
// reads as the ontology — secure → register → permit — not deploy/claim/delegate.
//
// Signature shape (per the "fewest taps" rule): `createHomeKey` is the one device gesture
// that mints the key; `secureHome` is one signed transaction that founds the home AND
// registers the name (two outcomes, one tap); `givePermission` is the one separate consent.
import type { Address } from '@agenticprimitives/types';
import {
  createSecureHomePasskey,
  connectWithName,
  createChildAgentForSite,
  passkeySignHash,
} from '../connect-client';
import { issueSiteDelegation, toWire } from '../lib/delegation';
import { ensureCsrfToken, csrfHeaders } from '../csrf';
import type { DemoPasskey } from '../lib/passkey';
import type { Home } from './types';
import { homeLabel } from './types';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** ①a — your device becomes your key: the only way to open your home. (WebAuthn create.) */
export async function createHomeKey(name: string): Promise<DemoPasskey> {
  return createSecureHomePasskey(name);
}

/**
 * ① + ② — Secure a home with your name. SPONSORED: the relayer founds the home (deploys the
 * SA, locked to your key) and registers your name — so the member's ONLY device gesture is
 * the passkey create (createHomeKey). No deploy/claim signature. Reserves a free name, deploys
 * via the direct-factory path, then registers it (owner = the home). Two outcomes, zero taps.
 */
export async function secureHome(key: DemoPasskey, name: string): Promise<Result<{ home: Home }>> {
  await ensureCsrfToken();
  // Reserve a free name in the community registry (forced-unique).
  const picked = (await (await fetch(`/connect/name?base=${encodeURIComponent(homeLabel(name))}`)).json().catch(() => ({}))) as {
    label?: string;
    name?: string;
    error?: string;
  };
  if (!picked.label || !picked.name) return { ok: false, error: picked.error ?? 'could not reserve a name' };

  // Found the home — relayer deploys the SA with the passkey as custodian (no user signature).
  const depRes = await fetch('/a2a/session/direct-deploy', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({
      mode: 0,
      initialPasskeyCredentialIdDigest: key.credentialIdDigest,
      initialPasskeyX: key.pubKeyX.toString(),
      initialPasskeyY: key.pubKeyY.toString(),
      salt: '0',
    }),
  });
  const dep = (await depRes.json().catch(() => ({}))) as { ok?: boolean; deployedAddress?: Address; error?: string; detail?: string };
  if (!depRes.ok || !dep.ok || !dep.deployedAddress) {
    return { ok: false, error: dep.detail ?? dep.error ?? `securing your home failed (HTTP ${depRes.status})` };
  }

  // Register the name in the community — relayer-sponsored, owner = the home (no signature).
  const regRes = await fetch('/a2a/session/register-name', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify({ label: picked.label, owner: dep.deployedAddress }),
  });
  const reg = (await regRes.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: string };
  if (!regRes.ok || !reg.ok) {
    return { ok: false, error: reg.detail ?? reg.error ?? `registering your name failed (HTTP ${regRes.status})` };
  }

  return { ok: true, home: { address: dep.deployedAddress, name: picked.name } };
}

/** Open your home from this device (prove it's you → a session). Used for sign-in + the
 *  self-serve landing. `via` = the credential you open it with (passkey or wallet). */
export async function openHome(name: string, via: 'passkey' | 'wallet' = 'passkey'): Promise<Result<{ token: string }>> {
  const out = await connectWithName(name, via);
  return out.ok ? { ok: true, token: out.token } : { ok: false, error: out.error };
}

/**
 * Set up an organization you'll help oversee — a home of its own, custodied by you, linked
 * to you on-chain, with a scoped grant for the app. (Wraps createChildAgentForSite.)
 */
export async function createOrganization(
  home: Home,
  base: string,
  delegate: Address,
): Promise<Result<{ org: { orgAgent: Address; orgName: string; edgeId: string; governed: boolean }; grant: unknown }>> {
  const r = await createChildAgentForSite(home.address, base, delegate);
  if (!r.ok) return r;
  const x = r.result;
  return {
    ok: true,
    org: { orgAgent: x.childAgent, orgName: x.childName, edgeId: x.edgeId, governed: x.governed },
    grant: x.delegation,
  };
}

/**
 * ③ — Give a missional-community app permission to act for you, on your terms (scoped,
 * revocable). One separate consent + signature — granting authority to someone else is a
 * distinct decision. Returns the signed grant to hand to the app.
 */
export async function givePermission(home: Home, delegate: Address): Promise<Result<{ grant: unknown }>> {
  try {
    const delegation = await issueSiteDelegation(home.address, delegate, passkeySignHash);
    return { ok: true, grant: toWire(delegation) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not grant permission' };
  }
}
