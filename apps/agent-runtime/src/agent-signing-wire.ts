// A SERVICE AGENT'S OWN A2A SIGNING WIRE — the library-read wire (slice S5's missing link).
//
// THE GAP. `library.granted.fetch` (#76) has a workspace (`.svc`, chartered by a person under `service.create`) send the A2A
// `library.granted.read` task to a publisher AS ITSELF. The runtime holds no key for the workspace, so the message is signed
// session-wrapped (`signAsOrg`): ECDSA by the interactions-session KMS key, presented WITH a wire the workspace's custodian
// signed (workspace → that key, allowedMethods pinned). The only ceremony that ever minted such a wire was the ORG
// routing-enable (`routing.orgWire`), which names consult/archetype selectors and requires the consult one — so no workspace
// held a wire, and every fetch was refused "no signing wire covers library.granted.read".
//
// THIS WIRE is the same artifact, minted by the same Home builder, verified by the same legs, for a SERVICE principal and for
// exactly one method: delegator = the service SA, delegate = the interactions-session key, caveats = timestamp window +
// allowedTargets [the service SA] + allowedMethods [skillSelector('library.granted.read')]. Never the any-skill sentinel and
// never another selector: what a leaked session key could do with it is "read what this workspace was granted", nothing more.
//
// IT IS KEPT UNDER ITS OWN KEY (`signing.serviceWire`), never under `routing.orgWire`: an org's consult wire must not be
// clobbered by a library wire, and an org wire must not be widened by one. The signer path asks for "the wire that covers
// THIS method" (`internal.signing.wire { skill }`), which reads both keys — the archetype dispatch's coverage rule, by
// selector membership.
//
// This file is the pure policy; the InteractionsDO does the I/O (ERC-1271 of the wire against the service, revocation).
import { A2A_ANY_SKILL, decodeAllowedMethodsTerms, decodeAllowedTargetsTerms, skillSelector, checkSessionWireShape } from '@agenticprimitives/a2a';
import type { Hex } from 'viem';
import type { IncomingDelegation } from './index.js';

/** The method a service's signing wire may carry. One entry today; adding one is a reviewed change, never a request field. */
export const SERVICE_SIGNING_WIRE_SKILLS = ['library.granted.read'] as const;
/** The InteractionsDO storage key the service wire lives under — separate from `routing.orgWire` by design. */
export const SERVICE_SIGNING_WIRE_KEY = 'signing.serviceWire';

export interface ServiceSigningWireRecord {
  wire: IncomingDelegation;
  hash: string;
  sessionKey: string;
  skills: string[];
  enabledBy: string;
  enabledAt: string;
}

export interface WireEnforcers { timestamp: string; allowedTargets: string; allowedMethods: string }

/**
 * The SHAPE a service signing wire must have to be stored. Null when it may; else the refusal, in words. Signature and
 * revocation are checked by the caller (they need the chain).
 *
 *   - delegator = this service; delegate = the interactions-session key (the key `signAsOrg` signs with).
 *   - `checkSessionWireShape` for each permitted skill — the identical check every A2A gate applies (timestamp live,
 *     allowedMethods present, never the any-skill sentinel, the skill named).
 *   - allowedMethods EXACTLY the permitted selector set: a wire that also names consult, an archetype or anything else is
 *     refused, because it would authorize more than this ceremony shows the person.
 *   - allowedTargets exactly [this service] — usable solely to act AS this service (the routing wire's own pin).
 */
export function serviceSigningWireError(
  wire: IncomingDelegation | undefined,
  o: { principal: string; sessionKey: string; enforcers: WireEnforcers; nowSec: number },
): string | null {
  if (!wire?.delegator || !wire.delegate || !wire.signature || !Array.isArray(wire.caveats)) return 'a signed delegation is required (delegator, delegate, caveats, signature)';
  if (wire.delegator.toLowerCase() !== o.principal.toLowerCase()) return 'the signing wire\'s delegator must be this service agent';
  if (wire.delegate.toLowerCase() !== o.sessionKey.toLowerCase()) return 'the signing wire\'s delegate must be the interactions-session key';
  const byEnforcer = (addr: string) => wire.caveats.find((c) => (c.enforcer ?? '').toLowerCase() === addr.toLowerCase());
  const am = byEnforcer(o.enforcers.allowedMethods);
  // The any-skill sentinel is named before the shape check's own words so the refusal says what it is.
  try {
    if (am?.terms && decodeAllowedMethodsTerms(am.terms as Hex).some((s) => s.toLowerCase() === A2A_ANY_SKILL.toLowerCase())) {
      return 'a service signing wire must never carry the any-skill sentinel';
    }
  } catch { return 'the signing wire\'s allowedMethods terms are undecodable'; }
  for (const skill of SERVICE_SIGNING_WIRE_SKILLS) {
    const e = checkSessionWireShape(wire as never, { timestamp: o.enforcers.timestamp, allowedMethods: o.enforcers.allowedMethods }, o.nowSec, { skill });
    if (e) return e;
  }
  const want = new Set(SERVICE_SIGNING_WIRE_SKILLS.map((s) => skillSelector(s).toLowerCase()));
  const named = decodeAllowedMethodsTerms(am!.terms as Hex).map((s) => s.toLowerCase());
  const extra = named.filter((s) => !want.has(s));
  if (extra.length || named.length !== want.size) {
    return `a service signing wire names exactly ${SERVICE_SIGNING_WIRE_SKILLS.join(', ')} — this one names ${extra.length ? `other methods too (${extra.join(', ')})` : 'a different set'}`;
  }
  const at = byEnforcer(o.enforcers.allowedTargets);
  if (!at?.terms) return 'the signing wire must carry an allowedTargets caveat naming this service agent';
  try {
    const targets = decodeAllowedTargetsTerms(at.terms as Hex).map((t) => t.toLowerCase());
    if (targets.length !== 1 || targets[0] !== o.principal.toLowerCase()) return 'the signing wire\'s allowedTargets must name exactly this service agent';
  } catch { return 'the signing wire\'s allowedTargets terms are undecodable'; }
  return null;
}

/** Does this wire's allowedMethods NAME the skill? Membership only — liveness is the signer's / gate's check. */
export function wireNamesSkill(wire: IncomingDelegation | null | undefined, allowedMethodsEnforcer: string, skill: string): boolean {
  if (!wire) return false;
  const am = (wire.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === allowedMethodsEnforcer.toLowerCase());
  if (!am?.terms) return false;
  try {
    return decodeAllowedMethodsTerms(am.terms as Hex).map((s) => s.toLowerCase()).includes(skillSelector(skill).toLowerCase());
  } catch { return false; }
}

/**
 * WHICH stored wire signs a message for `skill`: the service wire if it names the skill, else the org consult wire if IT
 * names the skill, else — when neither names it — whichever exists (so the signer's own shape check says precisely what is
 * missing, as #76 already does), else null.
 */
export function wireCovering(
  candidates: { service: IncomingDelegation | null; org: IncomingDelegation | null },
  allowedMethodsEnforcer: string,
  skill: string,
): IncomingDelegation | null {
  if (wireNamesSkill(candidates.service, allowedMethodsEnforcer, skill)) return candidates.service;
  if (wireNamesSkill(candidates.org, allowedMethodsEnforcer, skill)) return candidates.org;
  return candidates.org ?? candidates.service ?? null;
}
