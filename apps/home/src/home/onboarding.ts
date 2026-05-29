// The onboarding ACTIVITIES as first-class operations, named in the member's lexicon
// (docs/portal-lexicon.md). Each wraps the lower-level connect-client primitives so the flow
// reads as the ontology — secure → register → permit — not deploy/claim/delegate.
//
// A member secures + opens their home with one of several CREDENTIALS (`Via`): a passkey
// (this device), a wallet (SIWE/EOA custodian), or Google (a per-subject KMS-derived custodian
// the server signs with — see spec 235). The operations are via-parameterized so the journey
// branches on the chosen credential.
import type { Address, Hex } from '@agenticprimitives/types';
import {
  createSecureHomePasskey,
  deployAndClaimAgent,
  connectWithName,
  createChildAgentForSite,
  signupWithName,
  passkeySignHash,
  type SignHash,
} from '../connect-client';
import { connectWallet, personalSign } from '../lib/wallet';
import { issueSiteDelegation, toWire } from '../lib/delegation';
import type { DemoPasskey } from '../lib/passkey';
import type { Home } from './types';
import { homeLabel } from './types';

export type Via = 'passkey' | 'wallet' | 'google';
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** ①a — your device becomes your key (passkey path only; wallet/Google have no create step). */
export async function createHomeKey(name: string): Promise<DemoPasskey> {
  return createSecureHomePasskey(name);
}

/**
 * ① + ② — Secure a home with your name, with the chosen credential. The name claim must come
 * FROM the member's own Smart Agent (the subregistry is one-name-per-caller), so it's a signed
 * userOp from the custodian:
 *   passkey → deploy + claim signed by the just-created passkey (`key`).
 *   wallet  → deploy (EOA-custodied) + claim signed by the EOA (signupWithName).
 *   google  → handled by the server (the per-subject KMS custodian signs) — wired in spec 235.
 */
export async function secureHome(key: DemoPasskey | null, name: string, via: Via = 'passkey'): Promise<Result<{ home: Home }>> {
  if (via === 'wallet') {
    const out = await signupWithName(homeLabel(name), 'wallet', undefined, false);
    return out.ok ? { ok: true, home: { address: out.agent, name: out.name } } : { ok: false, error: out.error };
  }
  // passkey (Google's server-custody secure path is added in spec 235's client wiring)
  if (!key) return { ok: false, error: 'no key for this device' };
  const res = await deployAndClaimAgent(key, homeLabel(name));
  return res.ok ? { ok: true, home: { address: res.agent, name: res.name } } : { ok: false, error: res.error };
}

/** Open your home from this device (prove it's you → a session). `via` = the credential. */
export async function openHome(name: string, via: 'passkey' | 'wallet' = 'passkey'): Promise<Result<{ token: string }>> {
  const out = await connectWithName(name, via);
  return out.ok ? { ok: true, token: out.token } : { ok: false, error: out.error };
}

/** The signer for an on-behalf action (delegation / userOp), chosen by credential. */
async function signHashFor(via: Via): Promise<SignHash> {
  if (via === 'wallet') {
    const addr = await connectWallet();
    return (h: Hex) => personalSign(addr, h);
  }
  // passkey (Google's server-side signHash is wired in spec 235's client wiring)
  return passkeySignHash;
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
 * revocable). The delegation is signed by YOUR custodian (passkey or the wallet EOA), so the
 * signer is chosen by `via`. Returns the signed grant to hand to the app.
 */
export async function givePermission(home: Home, delegate: Address, via: Via = 'passkey'): Promise<Result<{ grant: unknown }>> {
  try {
    const signHash = await signHashFor(via);
    const delegation = await issueSiteDelegation(home.address, delegate, signHash);
    return { ok: true, grant: toWire(delegation) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not grant permission' };
  }
}
