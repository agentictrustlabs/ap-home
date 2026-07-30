// SESSION WIRES — how an agent signs as an identity whose key it does not hold.
//
// THE CALLER-SIGNATURE GAP, RESOLVED (spec 329 §3.1, generalized): a runtime holds no key for the
// identity it acts as — an org's DO holds no org key (SC-8), and a relying service must never
// custody the service agent it acts as (ADR-0019: a relying-site key is always a DELEGATE, never a
// custodian). Yet A2A needs per-message sender signatures and per-poll caller signatures that verify
// against THAT identity. A ceremony therefore mints a NARROW delegation — delegator = the identity,
// delegate = a KMS session key, allowedMethods = exactly ONE skill selector, allowedTargets pinned,
// timestamp-bounded — signed by the identity's own custody credential. The wire is stored by the
// runtime; NO raw key ever rests there, and the KMS key signs each digest on demand.
//
// THIS MODULE IS SKILL-AGNOSTIC. It was written for `discussion.consult` and pinned that selector
// internally, which meant the ONLY identity that could sign this way was an org on the consult rail.
// The shape is not consult-specific — it is the shape of every "sign as an identity you do not
// custody" case, including a service agent submitting `endeavor.request` under an Operational Intent
// grant. The caller now says which skill to pin; the module enforces it.
//
// On the wire, such a signature is the SESSION-WRAPPED form: `0x51` (a type byte no on-chain
// validator accepts — it fails closed anywhere but here) followed by hex(utf8(JSON({ wire, sig }))).
// The recipient's gate (a2a-task-do.ts OnChainChecks — the injected seam, package untouched) verifies
// it fail-closed PER MESSAGE: delegator === the claimed signer, timestamp window live, exactly one
// selector and never A2A_ANY_SKILL, the raw ECDSA sig recovers to the wire's delegate, the wire's own
// signature ERC-1271-verifies against the delegator, AND the wire is unrevoked on-chain — so a
// custodian's on-chain revocation kills the authority immediately at every gate.
import { hashMessage, keccak256, recoverAddress, toBytes, type Address, type Hex } from 'viem';
import { A2A_ANY_SKILL, decodeAllowedMethodsTerms, decodeTimestampTerms, skillSelector } from '@agenticprimitives/a2a';
import type { Delegation } from '@agenticprimitives/delegation';
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

/** Wrap a raw session-key ECDSA signature with the wire that authorizes it. */
export function wrapSessionSignature(wire: IncomingDelegation, sig: Hex): Hex {
  return (SESSION_WRAPPED_SIG_TYPE + utf8ToHex(JSON.stringify({ wire, sig })).slice(2)) as Hex;
}

/** Parse the session-wrapped form; null for any other signature shape (callers then fall back to
 *  the standard ERC-1271 path — one detector, no ambiguity). */
export function parseSessionWrappedSignature(signature: string): { wire: IncomingDelegation; sig: Hex } | null {
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

/**
 * Shape check for a session wire (used at ceremony store time AND at every gate hit):
 * timestamp-bounded, allowedMethods = exactly ONE selector, never the any-skill sentinel.
 *
 * `skill` PINS which selector, and callers should pass it wherever the skill is known — a wire minted
 * for one rail must not authorize another. It is omitted only where the request genuinely does not
 * name a skill: the read/control path (`tasks/get`, `tasks/cancel`, `pushNotificationConfig/set`),
 * whose digest binds a method and a taskId, not a skill. That omission is narrow rather than lax —
 * the wire must still be single-selector, non-any-skill, live, ERC-1271-valid and unrevoked, and the
 * package independently requires the caller to BE the task's sender or assignee
 * (`agent.ts`: "not a party to this task"). So an unpinned wire can only read tasks its delegator is
 * already a party to — exactly what that identity could do with its own key.
 */
export function checkSessionWireShape(
  wire: IncomingDelegation,
  enforcers: { timestamp: string; allowedMethods: string },
  nowSec: number,
  opts?: { skill?: string },
): string | null {
  const byEnforcer = (addr: string) => (wire.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === addr.toLowerCase());
  const tsCav = byEnforcer(enforcers.timestamp);
  if (!tsCav?.terms) return 'session wire must be timestamp-bounded';
  try {
    const win = decodeTimestampTerms(tsCav.terms as Hex);
    const now = BigInt(nowSec);
    if (now < win.validAfter || now >= win.validUntil) return 'session wire outside its timestamp window';
  } catch {
    return 'session wire timestamp terms undecodable';
  }
  const amCav = byEnforcer(enforcers.allowedMethods);
  if (!amCav?.terms) return 'session wire must carry an allowedMethods caveat';
  try {
    const selectors = decodeAllowedMethodsTerms(amCav.terms as Hex).map((s) => s.toLowerCase());
    if (selectors.some((s) => s === A2A_ANY_SKILL.toLowerCase())) return 'session wire must never carry the any-skill sentinel';
    if (selectors.length !== 1) return 'session wire allowedMethods must name exactly one selector';
    if (opts?.skill) {
      const want = skillSelector(opts.skill).toLowerCase();
      if (selectors[0] !== want) return `session wire allowedMethods must name exactly the ${opts.skill} selector`;
    }
  } catch {
    return 'session wire allowedMethods terms undecodable';
  }
  return null;
}

/**
 * Verify a session-wrapped signature for `signer` over `digest`, fail-closed on every leg.
 * `verifyDelegationSig` / `isRevoked` are the SAME injected on-chain checks the standard gate
 * uses (ERC-1271 against the delegator + DelegationManager.isRevoked) — revocation is immediate here.
 *
 * Pass `skill` whenever the request names one, so the wire is pinned to THAT rail; see
 * `checkSessionWireShape` for why the read/control path legitimately does not.
 */
export async function verifySessionWrappedSignature(args: {
  signer: Address;
  digest: Hex;
  signature: string;
  enforcers: { timestamp: string; allowedMethods: string };
  verifyDelegationSig: (d: Delegation) => Promise<boolean>;
  isRevoked: (d: Delegation) => Promise<boolean>;
  /** The skill the inbound message requests. Omit ONLY on the read/control path. */
  skill?: string;
  now?: number;
}): Promise<boolean> {
  const parsed = parseSessionWrappedSignature(args.signature);
  if (!parsed) return false;
  const { wire, sig } = parsed;
  if (wire.delegator.toLowerCase() !== args.signer.toLowerCase()) return false;
  const shapeOpts = args.skill ? { skill: args.skill } : undefined;
  if (checkSessionWireShape(wire, args.enforcers, Math.floor((args.now ?? Date.now()) / 1000), shapeOpts) !== null) return false;
  // The raw sig must recover to the wire's delegate (the KMS session key). Accept both
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
export const sessionBodyHash = (data: unknown): Hex => keccak256(toBytes(JSON.stringify(data ?? null)));
