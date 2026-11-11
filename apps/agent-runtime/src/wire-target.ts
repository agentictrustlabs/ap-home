// WHICH AGENT A SESSION WIRE IS CHECKED AGAINST (spec 445 RUN-9). `checkSessionWireShape` now REQUIRES the verifier's own
// agent as `target`: a wire is a credential only at the host it names. At a GATE that is the receiving agent. At STORE
// time (a ceremony keeping a wire for later) there is no single receiver — the wire will be presented at each agent it
// names — so the check asks the only question that can be asked then: does it name SOME target? The first one it names
// is handed over as `target`; a wire that names none gets the fallback, which it cannot match, so it is refused in the
// package's own words ("minted for another target"). The gate re-checks at every presentation against the real host.
import { decodeAllowedTargetsTerms } from '@agenticprimitives/a2a';
import type { Address, Hex } from 'viem';

/** The first agent the wire's allowedTargets caveat names, or `fallback` when it names none / cannot be read. */
export function namedTargetOr(
  wire: { caveats?: ReadonlyArray<{ enforcer?: string; terms?: string }> } | null | undefined,
  allowedTargetsEnforcer: string,
  fallback: string,
): Address {
  const cav = (wire?.caveats ?? []).find((c) => (c.enforcer ?? '').toLowerCase() === allowedTargetsEnforcer.toLowerCase());
  if (cav?.terms) { try { const t = decodeAllowedTargetsTerms(cav.terms as Hex)[0]; if (t) return t as Address; } catch { /* undecodable ⇒ the fallback, which refuses */ } }
  return fallback as Address;
}

/** The enforcer address, or '' when unset (the package then refuses: "the verifier has no allowedTargets enforcer"). */
export const enforcerOrEmpty = (v: string | undefined): string => /^0x[0-9a-fA-F]{40}$/.test(v ?? '') ? v!.toLowerCase() : '';
