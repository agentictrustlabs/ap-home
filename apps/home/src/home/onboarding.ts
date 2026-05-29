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
  deployAndClaimAgent,
  connectWithName,
  createChildAgentForSite,
  passkeySignHash,
} from '../connect-client';
import { issueSiteDelegation, toWire } from '../lib/delegation';
import type { DemoPasskey } from '../lib/passkey';
import type { Home } from './types';
import { homeLabel } from './types';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** ①a — your device becomes your key: the only way to open your home. (WebAuthn create.) */
export async function createHomeKey(name: string): Promise<DemoPasskey> {
  return createSecureHomePasskey(name);
}

/**
 * ① + ② — Secure a home with your name. The name registration must come FROM your Smart
 * Agent (the permissionless subregistry is one-name-per-caller, so a relayer can't register
 * on your behalf — it would only ever claim one name total). So this is ONE userOp signed by
 * your passkey: deploy the home (locked to your key) + claim the name, batched. Two outcomes,
 * one signed confirmation. (createHomeKey is the separate first gesture that mints the key.)
 */
export async function secureHome(key: DemoPasskey, name: string): Promise<Result<{ home: Home }>> {
  const res = await deployAndClaimAgent(key, homeLabel(name));
  if (!res.ok) return res;
  return { ok: true, home: { address: res.agent, name: res.name } };
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
