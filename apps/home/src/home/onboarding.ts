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
  createOrganizationWithGoogle,
  signupWithName,
  passkeySignHash,
  googleSignHash,
  secureHomeWithGoogle,
  secureHomeGoogleNoName,
  AUD,
  type SignHash,
} from '../connect-client';
import { startGoogleSignIn, startYouVersionSignIn } from '../server-client';
import { connectWallet, personalSign } from '../lib/wallet';
import { issueSiteDelegation, toWire } from '../lib/delegation';
import type { DemoPasskey } from '../lib/passkey';
import type { Home } from './types';
import { homeLabel } from './types';

export type Via = 'passkey' | 'wallet' | 'google' | 'youversion';
/** Extra auth a server-custodied op needs: the custody session token demo-a2a verifies. */
export type Auth = { token: string };
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** OIDC credentials that are KMS-custodied server-side (demo-a2a derives the custodian from the
 *  session's (iss, sub) — spec 235). Both sign + recover with no device gesture, unlike passkey/wallet.
 *  The signer path (`signHashFor`), org-create, and the recognized-connect grant all branch on this. */
export function isKmsVia(via: Via): boolean {
  return via === 'google' || via === 'youversion';
}

/** ①a — your device becomes your key (passkey path only; wallet/Google have no create step). */
export async function createHomeKey(name: string): Promise<DemoPasskey> {
  return createSecureHomePasskey(name);
}

/**
 * Begin Google sign-in for the Personal Home (a full-page redirect out to the broker, then back
 * to `?code`). A preferred name is stashed so the post-redirect secure-home step (GoogleSecureHome)
 * can offer it — the SA itself is derived from the Google identity, not the name. Used by both the
 * entry screen and the onboarding journey, so it lives here (no component cycle).
 */
export function continueWithGoogle(preferredName?: string, enrollStashJson?: string): void {
  try {
    if (preferredName) sessionStorage.setItem('pendingHomeName', preferredName);
    // Relying-app enrollment stashes its request here so the post-redirect resume can finish +
    // return the code; self-serve CLEARS any stale stash so it doesn't hijack a plain sign-in.
    if (enrollStashJson) sessionStorage.setItem('pendingEnroll', enrollStashJson);
    else sessionStorage.removeItem('pendingEnroll');
  } catch {
    /* storage blocked — the secure-home step will just ask for a name */
  }
  startGoogleSignIn(AUD, window.location.origin + '/');
}

/** Begin YouVersion sign-in for the Personal Home — identical to {@link continueWithGoogle} (full-page
 *  redirect out to the broker, back to `?code&via=youversion`). YouVersion is KMS-custodied like Google,
 *  so the post-redirect resume + secure-home steps are shared; only the IdP differs. */
export function continueWithYouVersion(preferredName?: string, enrollStashJson?: string): void {
  try {
    if (preferredName) sessionStorage.setItem('pendingHomeName', preferredName);
    if (enrollStashJson) sessionStorage.setItem('pendingEnroll', enrollStashJson);
    else sessionStorage.removeItem('pendingEnroll');
  } catch {
    /* storage blocked — the secure-home step will just ask for a name */
  }
  startYouVersionSignIn(AUD, window.location.origin + '/');
}

/**
 * ① + ② — Secure a home with your name, with the chosen credential. The name claim must come
 * FROM the member's own Smart Agent (the subregistry is one-name-per-caller), so it's a signed
 * userOp from the custodian:
 *   passkey → deploy + claim signed by the just-created passkey (`key`).
 *   wallet  → deploy (EOA-custodied) + claim signed by the EOA (signupWithName).
 *   google  → handled by the server (the per-subject KMS custodian signs) — wired in spec 235.
 */
export async function secureHome(
  key: DemoPasskey | null,
  name: string,
  via: Via = 'passkey',
  auth?: Auth,
): Promise<Result<{ home: Home }>> {
  if (via === 'google') {
    // Server custody: demo-a2a derives C_sub + deploys + claims, gated by the custody session.
    if (!auth?.token) return { ok: false, error: 'no custody session' };
    const out = await secureHomeWithGoogle(auth.token, homeLabel(name));
    return out.ok ? { ok: true, home: { address: out.agent, name: out.name } } : { ok: false, error: out.error };
  }
  if (via === 'wallet') {
    const out = await signupWithName(homeLabel(name), 'wallet', undefined, false);
    return out.ok ? { ok: true, home: { address: out.agent, name: out.name } } : { ok: false, error: out.error };
  }
  if (!key) return { ok: false, error: 'no key for this device' };
  const res = await deployAndClaimAgent(key, homeLabel(name));
  return res.ok ? { ok: true, home: { address: res.agent, name: res.name } } : { ok: false, error: res.error };
}

/**
 * spec 257 Phase 1.5 — TRUE name-deferral (Google only). Secure a home with NO name: the server
 * deploys the member's KMS-custodied SA with empty callData, leaving their single subregistry slot
 * FREE. The member is name-free after onboarding and claims a public handle LATER, by choice, via
 * the portal's ClaimPublicNameCard (`claimName`). Returns a home with an empty `name`.
 */
export async function secureHomeNoName(auth?: Auth): Promise<Result<{ home: Home }>> {
  if (!auth?.token) return { ok: false, error: 'no custody session' };
  const out = await secureHomeGoogleNoName(auth.token);
  return out.ok ? { ok: true, home: { address: out.agent, name: '' } } : { ok: false, error: out.error };
}

/** Open your home from this device (prove it's you → a session). `via` = the credential. */
export async function openHome(name: string, via: 'passkey' | 'wallet' = 'passkey'): Promise<Result<{ token: string }>> {
  const out = await connectWithName(name, via);
  return out.ok ? { ok: true, token: out.token } : { ok: false, error: out.error };
}

/** The signer for an on-behalf action (delegation / userOp), chosen by credential. `sender` is
 *  the SA the signature is for (needed by the Google server-signer to derive + scope C_sub).
 *  Exported so portal surfaces (e.g. the spec-257 W4 "Claim your public name" card) can sign a
 *  userOp with the member's CURRENT credential without re-deriving the signer logic. */
export async function signHashFor(via: Via, sender?: Address, auth?: Auth): Promise<SignHash> {
  if (via === 'wallet') {
    const addr = await connectWallet();
    return (h: Hex) => personalSign(addr, h);
  }
  if (isKmsVia(via)) {
    if (!sender || !auth?.token) throw new Error('granting with an OIDC home needs a custody session');
    return googleSignHash(sender, auth.token); // demo-a2a signs with the per-(iss,sub) KMS custodian
  }
  return passkeySignHash;
}

/**
 * Set up an organization you'll help oversee — a home of its own, custodied by you, with a
 * private vault credential recording the link (ADR-0025) + a scoped grant for the app.
 * (Wraps createChildAgentForSite.)
 */
export async function createOrganization(
  home: Home,
  base: string,
  delegate: Address,
  via: Via = 'passkey',
  auth?: Auth,
  opts: { purpose?: string; requestedBy?: string; grantOrg?: Address } = {},
): Promise<Result<{ org: Record<string, unknown>; grant: unknown }>> {
  // spec 256 — route by credential, like secureHome: a Google member's org is custodied by their
  // KMS C_sub and deployed server-side (ZERO device prompts); passkey/wallet sign on device.
  const r = isKmsVia(via)
    ? (auth?.token
        ? await createOrganizationWithGoogle(auth.token, base, delegate, opts)
        : ({ ok: false, error: 'creating an org with an OIDC home needs a custody session' } as const))
    : await createChildAgentForSite(home.address, base, delegate, undefined, undefined, opts);
  if (!r.ok) return r;
  const x = r.result;
  // ADR-0025: the `org` payload carries the private credential + the person SA so the
  // server's /oidc/grant step can write the vault; the relying app receives only the org
  // metadata + proofHash + (optional) brokerDelegation back via /token.
  return {
    ok: true,
    org: {
      orgAgent: x.childAgent,
      orgName: x.childName,
      person: x.person,
      purpose: x.purpose,
      requestedBy: x.requestedBy,
      proofHash: x.proofHash,
      credential: x.credential,
      brokerDelegation: x.brokerDelegation ?? null,
      membershipDelegation: x.membershipDelegation,   // person→org (org reads member)
      stewardshipDelegation: x.stewardshipDelegation,  // org→person (person reads org)
    },
    grant: x.delegation,
  };
}

/**
 * ③ — Give a missional-community app permission to act for you, on your terms (scoped,
 * revocable). The delegation is signed by YOUR custodian (passkey or the wallet EOA), so the
 * signer is chosen by `via`. Returns the signed grant to hand to the app.
 */
export async function givePermission(home: Home, delegate: Address, via: Via = 'passkey', auth?: Auth): Promise<Result<{ grant: unknown }>> {
  try {
    const signHash = await signHashFor(via, home.address, auth);
    const delegation = await issueSiteDelegation(home.address, delegate, signHash);
    return { ok: true, grant: toWire(delegation) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not grant permission' };
  }
}

/**
 * ④ — Consent to a specific agreement. Sign a FIXED consent digest with YOUR credential
 * (passkey / wallet / Google KMS) so a relying app can prove ON CHAIN (ERC-1271) that you —
 * or an org you steward, given as `party` — agreed to this exact agreement. Unlike a delegation,
 * this is a one-shot signature over a digest the relying app supplies; nothing is granted, scoped,
 * or revocable. `party` is the SA the signature must validate under: your home address for a
 * personal agreement, or a stewarded org SA you custody (same credential). The contract recomputes
 * the digest and verifies this signature via the party SA's ERC-1271 (AttestationRegistry RW1-1).
 */
export async function signConsent(party: Address, digest: Hex, via: Via = 'passkey', auth?: Auth): Promise<Result<{ signature: Hex }>> {
  try {
    const signHash = await signHashFor(via, party, auth);
    const signature = await signHash(digest);
    return { ok: true, signature };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not sign consent' };
  }
}
