// spec 329 §3.1 — the ORG consult wire + its session-wrapped signatures.
//
// THE CALLER-SIGNATURE GAP, RESOLVED: the org's runtime holds no org key (SC-8), yet the consult
// rail needs per-message sender signatures (message/send) and per-poll caller signatures
// (tasks/get) that verify against the ORG SA. The steward's routing-enable ceremony therefore
// mints a NARROW delegation — delegator = the org SA, delegate = the interactions-session KMS key
// (GCP_KMS_INTERACTIONS_KEY_NAME), allowedMethods = [the `discussion.consult` selector ONLY],
// allowedTargets = [the org SA] (usable solely to act AS this org), timestamp-bounded — signed by
// the org's custody credential (the steward's, client-side). The wire is custodied DO-side
// (spec-322 §2 custody rule, like the spec-323 delivery wire); NO raw key ever rests in the DO —
// the KMS key signs each digest on demand.
//
// On the wire, such a signature is the SESSION-WRAPPED form: `0x51` (a type byte no on-chain
// validator accepts — it fails closed anywhere but here) followed by hex(utf8(JSON({ wire, sig }))).
// The MEMBER's gate (a2a-task-do.ts OnChainChecks — the injected seam, package untouched) verifies
// it fail-closed PER MESSAGE: delegator === the claimed signer, timestamp window live, the consult
// selector pinned (never A2A_ANY_SKILL), the raw ECDSA sig recovers to the wire's delegate, the
// wire's own signature ERC-1271-verifies against the org, AND the wire is unrevoked on-chain — so
// a steward's on-chain revocation kills routing authority immediately at every member's gate.
import { hashMessage, keccak256, recoverAddress, toBytes, type Address, type Hex } from 'viem';
import { A2A_ANY_SKILL, decodeAllowedMethodsTerms, decodeTimestampTerms, skillSelector } from '@agenticprimitives/a2a';
import type { Delegation } from '@agenticprimitives/delegation';
import { CONSULT_SKILL_ID } from '@agenticprimitives/fabric/messaging';
import type { IncomingDelegation } from './index.js';

/** Signature type byte for the session-wrapped form. Unknown to AgentAccount `_validateSig`
 *  (fails closed on-chain) and to every other verifier — only the demo-a2a consult gate below
 *  accepts it, and only after full verification. */
export const SESSION_WRAPPED_SIG_TYPE = '0x51';

const utf8ToHex = (s: string): Hex => `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
const hexToUtf8 = (h: string): string => {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
};

/** Wrap a raw session-key ECDSA signature with the org consult wire that authorizes it. */
export function wrapRoutedConsultSignature(wire: IncomingDelegation, sig: Hex): Hex {
  return (SESSION_WRAPPED_SIG_TYPE + utf8ToHex(JSON.stringify({ wire, sig })).slice(2)) as Hex;
}

/** Parse the session-wrapped form; null for any other signature shape (callers then fall back to
 *  the standard ERC-1271 path — one detector, no ambiguity). */
export function parseRoutedConsultSignature(signature: string): { wire: IncomingDelegation; sig: Hex } | null {
  if (!signature?.startsWith(SESSION_WRAPPED_SIG_TYPE) || signature.length <= SESSION_WRAPPED_SIG_TYPE.length) return null;
  try {
    const parsed = JSON.parse(hexToUtf8(`0x${signature.slice(SESSION_WRAPPED_SIG_TYPE.length)}`)) as { wire?: IncomingDelegation; sig?: Hex };
    if (!parsed?.wire?.delegator || !parsed.wire.delegate || !parsed.wire.signature || !parsed.sig) return null;
    return { wire: parsed.wire, sig: parsed.sig };
  } catch {
    return null;
  }
}

export function toDelegation(w: IncomingDelegation): Delegation {
  return {
    delegator: w.delegator,
    delegate: w.delegate,
    authority: w.authority,
    caveats: w.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: (c.args ?? '0x') as Hex })),
    salt: BigInt(w.salt),
    signature: w.signature,
  };
}

/** Shape check for the ORG consult wire (used at ceremony store time AND at every gate hit):
 *  timestamp-bounded, allowedMethods = exactly the `discussion.consult` selector (never the
 *  any-skill sentinel). Returns an error string or null. */
export function checkConsultWireShape(
  wire: IncomingDelegation,
  enforcers: { timestamp: string; allowedMethods: string },
  nowSec: number,
): string | null {
  const byEnforcer = (addr: string) => (wire.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === addr.toLowerCase());
  const tsCav = byEnforcer(enforcers.timestamp);
  if (!tsCav?.terms) return 'org consult wire must be timestamp-bounded';
  try {
    const win = decodeTimestampTerms(tsCav.terms as Hex);
    const now = BigInt(nowSec);
    if (now < win.validAfter || now >= win.validUntil) return 'org consult wire outside its timestamp window';
  } catch {
    return 'org consult wire timestamp terms undecodable';
  }
  const amCav = byEnforcer(enforcers.allowedMethods);
  if (!amCav?.terms) return 'org consult wire must carry an allowedMethods caveat';
  try {
    const selectors = decodeAllowedMethodsTerms(amCav.terms as Hex).map((s) => s.toLowerCase());
    const want = skillSelector(CONSULT_SKILL_ID).toLowerCase();
    if (selectors.some((s) => s === A2A_ANY_SKILL.toLowerCase())) return 'org consult wire must never carry the any-skill sentinel';
    if (selectors.length !== 1 || selectors[0] !== want) return 'org consult wire allowedMethods must name exactly the discussion.consult selector';
  } catch {
    return 'org consult wire allowedMethods terms undecodable';
  }
  return null;
}

/**
 * Verify a session-wrapped signature for `signer` over `digest`, fail-closed on every leg.
 * `verifyDelegationSig` / `isRevoked` are the SAME injected on-chain checks the standard gate
 * uses (ERC-1271 against the org + DelegationManager.isRevoked) — revocation is immediate here.
 */
export async function verifyRoutedConsultSignature(args: {
  signer: Address;
  digest: Hex;
  signature: string;
  enforcers: { timestamp: string; allowedMethods: string };
  verifyDelegationSig: (d: Delegation) => Promise<boolean>;
  isRevoked: (d: Delegation) => Promise<boolean>;
  now?: number;
}): Promise<boolean> {
  const parsed = parseRoutedConsultSignature(args.signature);
  if (!parsed) return false;
  const { wire, sig } = parsed;
  if (wire.delegator.toLowerCase() !== args.signer.toLowerCase()) return false;
  if (checkConsultWireShape(wire, args.enforcers, Math.floor((args.now ?? Date.now()) / 1000)) !== null) return false;
  // The raw sig must recover to the wire's delegate (the interactions-session key). Accept both
  // raw-digest and eth-signed-message recovery, mirroring AgentAccount._verifyEcdsa.
  const delegate = wire.delegate.toLowerCase();
  let recovered = false;
  try { recovered = (await recoverAddress({ hash: args.digest, signature: sig })).toLowerCase() === delegate; } catch { /* try wrapped */ }
  if (!recovered) {
    try { recovered = (await recoverAddress({ hash: hashMessage({ raw: toBytes(args.digest) }), signature: sig })).toLowerCase() === delegate; } catch { return false; }
  }
  if (!recovered) return false;
  const d = toDelegation(wire);
  try {
    if (await args.isRevoked(d)) return false; // steward revoke ⇒ immediate kill at every gate
    return await args.verifyDelegationSig(d);
  } catch {
    return false; // fail-closed on chain-read failure (ADR-0013)
  }
}

/** keccak over stable-JSON — the a2a body-hash convention (must equal a2a-task-do's hashBody). */
export const consultBodyHash = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));
