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

/** Sensitive PII requires a custody-grade session (the on-chain-confirmed floor). */
export function canReadSensitivePii(session: AgentSession): boolean {
  return session.assurance === 'onchain-confirmed';
}

export interface BasicProfile {
  agent: string; // canonical id (sub)
  name: string | null; // .demo.agent primary name (reverse-resolved), if any
  credential: string; // the credential kind that authenticated
  access: 'standard' | 'full (confirmed with device)';
}

export interface SensitivePiiFields {
  email: string;
  phone: string;
}

/** Basic profile — open to ANY valid session (login-grade included). */
export function basicProfile(session: AgentSession, name: string | null): BasicProfile {
  return {
    agent: session.sub,
    name,
    credential: session.principal.kind,
    access: canReadSensitivePii(session) ? 'full (confirmed with device)' : 'standard',
  };
}

/** Sensitive PII — custody-grade only; null = denied (caller returns step-up). PII is
 *  keyed on the canonical agent id (never email, CN-3). Demo store; prod = KV/D1. */
export function sensitivePii(session: AgentSession): SensitivePiiFields | null {
  if (!canReadSensitivePii(session)) return null; // default-deny
  const addr = session.sub.split(':').pop() ?? 'agent';
  return { email: `${addr.slice(0, 8).toLowerCase()}@demo.agent`, phone: '+1 415 555 0123' };
}
