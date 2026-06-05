// Person-MCP PII access, gated by the Connect AgentSession (spec 227 §7 / ADR-0017).
// The "person MCP" for the demo is served from the Connect origin itself (a Pages
// Function) which verifies the SAME-origin AgentSession against the broker JWKS —
// the architect-clean app-layer verify (NOT mcp-runtime withDelegation; this is
// session-gated, not delegation-gated).
//
// Gate (P1-E): sensitive PII requires the cryptographic floor
// `assurance === 'onchain-confirmed'` (a custody-grade session) — NOT the advisory
// `principal.role`. Default-deny: only the basic profile is open to login-grade.

import type { AgentSession } from '@agenticprimitives/types';

/** SEC-014: defense-in-depth namespace gate. PII reads NEVER derive a key from
 *  parsing `session.sub` as an address unless the sub is in a custodied namespace
 *  (CAIP-10 eip155). A non-custodied namespace coming through would be a bug
 *  upstream (canIssueSession enforces it at issuance), but the PII handler keys data
 *  on `sub` so the secondary check here ensures a future regression doesn't open a
 *  cross-namespace data leak. */
function isCustodiedSubject(sub: string | undefined | null): boolean {
  if (!sub) return false;
  // CAIP-10: `<namespace>:<reference>:<address>` — we accept eip155 with a 0x-prefixed 20-byte address.
  return /^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(sub);
}

/** Sensitive PII requires a custody-grade session (the on-chain-confirmed floor)
 *  AND a CAIP-10 sub in a custodied namespace (SEC-014 defense-in-depth). */
export function canReadSensitivePii(session: AgentSession): boolean {
  if (session.assurance !== 'onchain-confirmed') return false;
  if (!isCustodiedSubject(session.sub)) return false;
  return true;
}

export interface BasicProfile {
  agent: string; // canonical id (sub)
  name: string | null; // .demo.agent primary name (reverse-resolved), if any
  credential: string; // the credential kind that authenticated
  access: 'standard' | 'full (confirmed with device)';
  // spec 257 Phase 1.5 — is the SA actually deployed on-chain? A Google member returns in a
  // custody session whose `sub` is a COUNTERFACTUAL (not-yet-deployed) SA; the portal gate routes
  // them to secure-home ONLY while `deployed === false`. A NAMELESS deployed home (true
  // name-deferral) has `deployed: true, name: null` and falls through to the portal.
  deployed: boolean;
}

export interface SensitivePiiFields {
  email: string;
  phone: string;
}

/** Basic profile — open to ANY valid session (login-grade included). `deployed` is the on-chain
 *  bytecode signal the caller computes (the SA may be counterfactual on a fresh Google return). */
export function basicProfile(session: AgentSession, name: string | null, deployed: boolean): BasicProfile {
  return {
    agent: session.sub,
    name,
    credential: session.principal.kind,
    access: canReadSensitivePii(session) ? 'full (confirmed with device)' : 'standard',
    deployed,
  };
}

/** Sensitive PII — custody-grade only; null = denied (caller returns step-up). PII is
 *  keyed on the canonical agent id (never email, CN-3). Demo store; prod = KV/D1.
 *  SEC-014: re-asserts the namespace + custody gate at the call site (the helper
 *  above is the load-bearing version, but we never trust an upstream check alone). */
export function sensitivePii(session: AgentSession): SensitivePiiFields | null {
  if (!canReadSensitivePii(session)) return null; // default-deny — re-asserts namespace + custody
  if (!isCustodiedSubject(session.sub)) return null; // belt-and-suspenders before address parsing
  const addr = session.sub.split(':').pop() ?? 'agent';
  return { email: `${addr.slice(0, 8).toLowerCase()}@demo.agent`, phone: '+1 415 555 0123' };
}
