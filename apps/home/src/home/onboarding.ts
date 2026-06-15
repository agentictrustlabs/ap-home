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
  connectCustodianWallet,
  secureHomeWithGoogle,
  secureHomeGoogleNoName,
  chargePayment,
  collectSubscriptions,
  AUD,
  type SignHash,
} from '../connect-client';
import { startGoogleSignIn, startYouVersionSignIn } from '../server-client';
import { connectWallet, personalSign } from '../lib/wallet';
import { issueSiteDelegation, issueSessionDelegation, issuePaymentDelegation, OPEN_DELEGATION, toWire, type DelegationWire } from '../lib/delegation';
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
    // Sign with the wallet that CUSTODIES `sender` (the home SA) — not MetaMask's active account (which
    // may be another home's custodian, e.g. the platform deployer). This is the relying-app GRANT signer,
    // so the site/session/payment delegations must be signed by the home's actual custodian. Falls back to
    // the active account only when no sender is known (shouldn't happen on the grant path).
    const addr = sender ? await connectCustodianWallet(sender) : await connectWallet(true);
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
export async function givePermission(
  home: Home,
  delegate: Address,
  via: Via = 'passkey',
  auth?: Auth,
  /** spec 270 v4 W2 — the RELYING APP's session-key address (the relying app generates the keypair and
   *  keeps the private key; only its public address reaches the home). When present, the same credential
   *  that signs the site delegation also signs the DEL-001 leaf binding that key to the person SA. */
  sessionKeyAddress?: Address,
  /** spec 272/243 — when the relying app requested the `x402-pay` template, ALSO issue a capped
   *  payment delegation from the member's TREASURY SA (custodied by the SAME credential as the person
   *  SA, MAM-D2 — so the same `signHash` authorizes it; the custodian never appears as a party). The
   *  public delegation crosses back to the app, which stores it in the payee's vault and redeems it per
   *  paid read. `mode`: 'push' (x402 — OPEN delegate, the reader redeems) | 'pull' (delegate = payee,
   *  the provider redeems on its schedule — subscriptions). The PaymentEnforcer caps every charge. */
  payment?: {
    treasury: Address;
    payee: Address;
    asset: Address;
    maxAmountPerCharge: bigint;
    maxAggregate: bigint;
    maxRedemptionsPerWindow?: number;
    windowSeconds?: number;
    mode?: 'push' | 'pull';
    /** spec 272 — also CHARGE the first/top-up payment in THIS ceremony (all-custodian via signHash):
     *  the person SA redeems the push delegation → `chargeAmount` USDC moves person-treasury → payee.
     *  The relying app verifies the returned settlementHash on-chain and mints a `reads`-read pass. */
    chargeNow?: boolean;
    chargeAmount?: bigint;
    edition?: string;
    /** spec 272 recurring lane — when set, this connect is a SUBSCRIPTION: in addition to the first
     *  period's push charge, mint a STANDING `treasury → payee` PULL mandate (delegate = payee) the
     *  provider can redeem once per `periodSeconds` to renew, capped at `chargeAmount`/period and
     *  `chargeAmount × periods` total. Returned as `pullDelegation`; the app stores it in the payee's
     *  vault. (Unattended redemption needs the provider's signer — left to an owner-online step.) */
    subscription?: { periodSeconds: number; periods?: number };
  },
): Promise<Result<{ grant: unknown; sessionDelegation?: DelegationWire; paymentDelegation?: DelegationWire; pullDelegation?: DelegationWire; settlementHash?: Hex }>> {
  try {
    const signHash = await signHashFor(via, home.address, auth);
    const delegation = await issueSiteDelegation(home.address, delegate, signHash);
    // The leaf is signed in the SAME ceremony, by the SAME credential. Only the PUBLIC leaf crosses back
    // to the relying app — the session private key never leaves the relying app (no cross-origin key
    // transport). The relying app signs its tokens with that key + presents the leaf; the verifier binds
    // it to the person SA's authority (closing observe-and-re-mint). One credential interaction covers both.
    const sessionDelegation = sessionKeyAddress
      ? toWire(await issueSessionDelegation(home.address, sessionKeyAddress, signHash))
      : undefined;
    // x402 payment delegation — issued from the TREASURY, signed by the same credential, in the same
    // ceremony. delegate = OPEN (push: reader redeems) or the payee (pull: provider redeems).
    const payDeleg = payment
      ? await issuePaymentDelegation(
          payment.treasury,
          payment.mode === 'pull' ? payment.payee : OPEN_DELEGATION,
          payment.payee,
          signHash,
          {
            asset: payment.asset,
            maxAmountPerCharge: payment.maxAmountPerCharge,
            maxAggregate: payment.maxAggregate,
            maxRedemptionsPerWindow: payment.maxRedemptionsPerWindow,
            windowSeconds: payment.windowSeconds,
          },
        )
      : undefined;
    // ALL-CUSTODIAN CHARGE (spec 272): redeem the just-minted push delegation IN this ceremony — the
    // person SA executes it, signed by the SAME credential (signHash), gaslessly. Moves chargeAmount USDC
    // person-treasury → payee; the relying app verifies the tx + mints a pass. Non-fatal: if the charge
    // fails (treasury underfunded), the delegation is still returned so the app can settle later.
    let settlementHash: Hex | undefined;
    if (payDeleg && payment?.chargeNow && payment.chargeAmount && payment.mode !== 'pull') {
      const charged = await chargePayment(home.address, payDeleg, signHash, {
        payee: payment.payee, asset: payment.asset, amount: payment.chargeAmount, edition: payment.edition ?? 'lbsb',
      });
      if (charged.ok) settlementHash = charged.settlementHash;
    }
    // SUBSCRIPTION (spec 272 recurring): ALSO mint a standing PULL mandate (delegate = payee, so the
    // provider redeems) from the SAME treasury, signed by the SAME credential. Per-period cap = the tier
    // price (chargeAmount); window = the billing period; one redemption per window; aggregate bounds the
    // number of auto-renewals. The app stores it in the payee's vault. This is the "person delegates the
    // payee the ability to charge a subscription" half — distinct from the push delegation used above.
    let pullDeleg: Awaited<ReturnType<typeof issuePaymentDelegation>> | undefined;
    if (payment?.subscription && payment.chargeAmount) {
      const perPeriod = payment.chargeAmount;
      const periods = BigInt(Math.max(1, payment.subscription.periods ?? 12));
      const aggregate = perPeriod * periods;
      pullDeleg = await issuePaymentDelegation(payment.treasury, payment.payee, payment.payee, signHash, {
        asset: payment.asset,
        maxAmountPerCharge: perPeriod,
        maxAggregate: aggregate <= payment.maxAggregate ? aggregate : payment.maxAggregate,
        maxRedemptionsPerWindow: 1,
        windowSeconds: payment.subscription.periodSeconds,
      });
    }
    return { ok: true, grant: toWire(delegation), sessionDelegation, paymentDelegation: payDeleg ? toWire(payDeleg) : undefined, pullDelegation: pullDeleg ? toWire(pullDeleg) : undefined, settlementHash };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not grant permission' };
  }
}

/**
 * spec 272 recurring — OWNER-online subscription collection. The owner (custodian of the collection
 * treasury, e.g. lbsb-treasury.impact) signs, with their own credential, the redemption of every DUE
 * subscriber's standing pull mandate — one ceremony bills them all. signHashFor signs for the TREASURY
 * (the redeemer/delegate), so the treasury's ERC-1271 validates the owner credential as its custodian.
 * No held key: if the connecting person doesn't custody the treasury, every redemption simply fails.
 */
export async function collectDueSubscriptions(
  treasury: Address,
  via: Via,
  auth: Auth | undefined,
  opts: { asset: Address; edition: string; a2aBase: string; idToken: string },
  onStep?: (s: string) => void,
): Promise<Result<{ attempted: number; collected: number; results: Array<{ subscriptionId?: number; subject?: string; ok: boolean; settlementHash?: Hex; error?: string }> }>> {
  try {
    const signHash = await signHashFor(via, treasury, auth);
    const res = await collectSubscriptions({ treasury, asset: opts.asset, edition: opts.edition, a2aBase: opts.a2aBase, idToken: opts.idToken, signHash, onStep });
    if (!res.ok) return { ok: false, error: res.error ?? 'collection failed' };
    return { ok: true, attempted: res.attempted, collected: res.collected, results: res.results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not collect subscriptions' };
  }
}

/**
 * spec 266 delegated content trust — PER-CUSTODIAN: each signing identity (bsb.impact, lbsb.impact,
 * demo-validator.impact) is authorized only by WHOEVER CUSTODIES that SA. The connected custodian signs ONCE
 * a delegation binding their SA → its KMS key; the content service verifies the SA actually signed it
 * (ERC-1271) before storing. `opts.targetSigner` scopes the ceremony to the single identity the custodian
 * connected as, so each runs a clean "1 of 1" (you can only delegate authority you hold). NO held key.
 */
export async function authorizeContentSigningForOwner(
  via: Via,
  auth: Auth | undefined,
  opts: { a2aBase: string; idToken: string; targetSigner?: string },
  onStep?: (s: string) => void,
): Promise<Result<{ attempted: number; authorized: number; results: Array<{ issuerName: string; ok: boolean; error?: string }> }>> {
  try {
    const base = opts.a2aBase.replace(/\/$/, '');
    onStep?.('Reading signing identities + their HSM-backed KMS keys…');
    const keysRes = (await fetch(`${base}/admin/content-signer-keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: opts.idToken }),
    }).then((r) => r.json()).catch(() => ({ ok: false }))) as { ok?: boolean; signers?: Array<{ issuerName: string; issuerSa: Address; delegateKey: Address }>; error?: string };
    if (!keysRes.ok) return { ok: false, error: keysRes.error ?? 'could not read content-signer keys' };
    // Scope to the identity the custodian connected as — they can only authorize the SA they custody.
    const all = keysRes.signers ?? [];
    const signers = opts.targetSigner ? all.filter((s) => s.issuerName.toLowerCase() === opts.targetSigner!.toLowerCase()) : all;
    if (opts.targetSigner && signers.length === 0) return { ok: false, error: `signing identity ${opts.targetSigner} not provisioned a key yet` };
    const results: Array<{ issuerName: string; ok: boolean; error?: string }> = [];
    const oneYear = 365 * 24 * 60 * 60;
    for (let i = 0; i < signers.length; i++) {
      const s = signers[i]!;
      onStep?.(`Authorizing ${s.issuerName} (${i + 1}/${signers.length})…`);
      try {
        // Sign AS the issuer SA (the owner custodies it). The leaf binds issuerSa → its KMS key address.
        const signHash = await signHashFor(via, s.issuerSa, auth);
        const leaf = toWire(await issueSessionDelegation(s.issuerSa, s.delegateKey, signHash, oneYear));
        const stored = (await fetch(`${base}/admin/store-content-signer`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id_token: opts.idToken, issuerName: s.issuerName, issuerSa: s.issuerSa, delegateKey: s.delegateKey, delegationLeaf: leaf }),
        }).then((r) => r.json()).catch(() => ({ ok: false }))) as { ok?: boolean; error?: string };
        results.push({ issuerName: s.issuerName, ok: !!stored.ok, error: stored.ok ? undefined : (stored.error ?? 'store failed') });
      } catch (e) {
        results.push({ issuerName: s.issuerName, ok: false, error: e instanceof Error ? e.message : 'sign failed' });
      }
    }
    return { ok: true, attempted: signers.length, authorized: results.filter((r) => r.ok).length, results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'could not authorize content signing' };
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
