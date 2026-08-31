// The authority a person's own Agent Card Studio runs on (spec 345 + spec 347 §9).
//
// An org or service agent's Studio runs on the STEWARDSHIP delegation (delegator = the managed agent,
// delegate = the person). A person has no steward: they ARE the agent. So the person's Studio runs on a
// SELF VAULT GRANT — `delegator = delegate = personSA` — scoped to exactly the record families the Studio
// touches. That is the mechanism spec 345 exists to provide, and using it here is the whole point of it:
// the alternative people reach for is pointing the org-connect ceremony at their own address, which is
// the bug spec 345 §0 was written about (it mints a stewardship link and the person shows up in their own
// org list).
//
// WHY A DELEGATION AND NOT THE HOME SESSION: the A2A→MCP hop's authority is always the chain — an
// on-chain-verifiable, SA-signed, revocable delegation (ADR-0041). A session token is an ingress
// envelope, never authority, so "they're signed in as themselves" does not open the vault.
//
// WHY IT IS PERSISTED: minting costs one signature. On a passkey or wallet home that is a device prompt,
// and a prompt on every visit to a read-only screen is exactly the "value steps ≠ signatures" rule being
// broken. The grant is minted once, verified and stored server-side, and reused — the same lifecycle the
// stewardship delegation already has.
import type { Address } from '@agenticprimitives/types';
import { issueSelfVaultGrant, toWire, type DelegationWire, type SelfVaultGrantConfig } from './delegation';
import { MCP_SERVER_ID } from './inbox-delivery';
import type { SignHash } from '../connect-client';

/** Exactly the record families the Studio reads and writes — `agent-cards:*`, `projections:*`,
 *  `bindings:*`, `approvals:*` (STUDIO_KEYS in demo-a2a's agent-card-studio.ts).
 *
 *  Deliberately NOT the whole vault. The person's PII, relationships, messages and library are none of
 *  the Studio's business, and a grant that could read them would be handing a card editor the keys to
 *  everything. `buildVaultRecordScopeCaveat` refuses `vault:*` outright, but a family list is the point,
 *  not a workaround for that. */
export const STUDIO_VAULT_SCOPE: SelfVaultGrantConfig = {
  server: MCP_SERVER_ID,
  resources: ['vault:agent-cards:*', 'vault:projections:*', 'vault:bindings:*', 'vault:approvals:*'],
  ops: ['read', 'write'],
};

/** Read the stored grant for the signed-in person; `null` when there is none or it has expired. */
async function loadStoredGrant(token: string): Promise<DelegationWire | null> {
  const r = await fetch('/connect/self-grant?purpose=agent-card-studio', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { grant?: DelegationWire | null };
  return j.grant ?? null;
}

async function storeGrant(token: string, grant: DelegationWire): Promise<void> {
  const r = await fetch('/connect/self-grant?purpose=agent-card-studio', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ grant }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `could not save the grant (HTTP ${r.status})`);
  }
}

/**
 * The person's Studio grant: the stored one if it is still live, otherwise one fresh signature.
 *
 * `signHash` is the caller's already-resolved signer (routed by the home's real credential, never a raw
 * `session.via` — a KMS home must not pop MetaMask). The mint is the ONE moment this asks the person for
 * anything; every later visit reads the stored grant.
 */
let inFlight: { person: string; p: Promise<DelegationWire> } | null = null;

export async function ensureStudioSelfGrant(input: {
  personSA: Address;
  token: string;
  signHash: SignHash;
}): Promise<DelegationWire> {
  const person = input.personSA.toLowerCase();
  // Two components (or one effect re-running) must not each mint: on a passkey home that is TWO device
  // prompts for one grant, and the second one is pure noise. Callers share the first attempt.
  const flying = inFlight;
  if (flying && flying.person === person) return flying.p;
  const p = (async (): Promise<DelegationWire> => {
    const stored = await loadStoredGrant(input.token);
    if (stored) return stored;
    const grant = await issueSelfVaultGrant(input.personSA, STUDIO_VAULT_SCOPE, input.signHash);
    const wire = toWire(grant);
    await storeGrant(input.token, wire);
    return wire;
  })();
  inFlight = { person, p };
  try {
    return await p;
  } finally {
    if (inFlight?.p === p) inFlight = null;
  }
}
