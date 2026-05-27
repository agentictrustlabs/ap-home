// The in-browser demo broker — generates a signing key in-page so the demo is
// self-contained + runnable with no backend. The reusable directory + issuance
// logic lives in ./lib/broker-core (shared with the server-side Pages Function
// broker in functions/, which uses the same core with a key from an env secret).
//
// ⚠️ DEMO SIMPLIFICATION: in PRODUCTION the broker key lives server-side at the
// Connect origin (the Pages Function broker); the browser only sees the JWKS.

import { generateBrokerKeypair, publishJwks, type IssueOutcome, type VerifyResult } from '@agenticprimitives/connect';
import type { CredentialPrincipal, AgentSession } from '@agenticprimitives/types';
import type { IdentityDirectory } from '@agenticprimitives/identity-directory';
import { buildDemoDirectory, issueForRelyingSite, verifyTokenWithJwks, canPerform } from './lib/broker-core';

export { ALICE_PASSKEY, ALICE_OIDC, BOB_PASSKEY, ALICE, BOB } from './lib/broker-core';

/** The Connect origin for this (in-browser) broker = the serving origin. */
const ISS = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5373';

export type Jwks = Awaited<ReturnType<typeof publishJwks>>;

export interface DemoBroker {
  readonly kid: string;
  readonly jwks: Jwks;
  readonly directory: IdentityDirectory;
  login(principal: CredentialPrincipal, aud: string): Promise<IssueOutcome>;
  verifyForRelyingSite(token: string, aud: string): Promise<VerifyResult>;
  canPerform(session: AgentSession, action: string): { ok: boolean; reason?: string };
}

export async function createDemoBroker(): Promise<DemoBroker> {
  const signer = await generateBrokerKeypair('ES256'); // ES256 — works in workerd + browsers + Node
  const jwks = await publishJwks([signer]);
  const directory = buildDemoDirectory();
  return {
    kid: signer.kid,
    jwks,
    directory,
    login: (principal, aud) => issueForRelyingSite(directory, signer, principal, aud, ISS),
    verifyForRelyingSite: (token, aud) => verifyTokenWithJwks(jwks, token, aud, ISS),
    canPerform,
  };
}
