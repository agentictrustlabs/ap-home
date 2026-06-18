// demo-mcp's key-release gate (spec 277 Phase 4).
//
// After the entitlement gate allows a read, the handler does NOT decrypt
// directly — it requests a one-time DecryptGrant and runs it through the KAS.
// Only on KAS allow does the vault decrypt the released fields. This makes the
// DecryptGrant the enforcement boundary (binding principal / tool / argsHash /
// resource / fields / purpose / classification / one-time JTI), per spec 277.
//
// Demo note: the grant is created AND verified in-process within the same
// request (it never leaves the server), so the one-time JTI is satisfied by a
// fresh per-call replay store. A real cross-request flow (client requests a
// grant, presents it later) needs a durable replay ledger (D1 / Durable Object)
// and a signed grant proof — those are additive (key-authorization §14).

import {
  createDecryptGrant,
  verifyDecryptGrant,
  createInMemoryReplayStore,
  sha256Hex,
  type KeyReleaseDecision,
  type VaultKeyAuthorizationVerifier,
  type VaultKeyBindingV1,
} from '@agenticprimitives/key-authorization';

export interface AuthorizeDecryptInput {
  principal: string;
  audience: string;
  serverId: string;
  toolName: string;
  /** The tool's request args — hashed and bound into the grant + checked by the KAS. */
  args: unknown;
  resource: string;
  classification: string;
  /** The fields the entitlement gate authorized (the grant + release are scoped to these). */
  allowedFields?: string[];
  purpose?: string;
  /** The entitlement credential ids that matched (bound into the grant by hash). */
  entitlementIds?: string[];
  ttlSeconds?: number;
  /**
   * spec 278 — the per-person vault-key authorization (REQUIRED for person data). The KAS
   * additionally requires this to pass before release: the host may wield the person's KEK
   * only because the person SA authorized it (verified per op). No binding ⇒ the caller never
   * reaches here (it fails closed earlier).
   */
  vaultKeyAuthorization: {
    verifier: VaultKeyAuthorizationVerifier;
    authorization: unknown;
    binding: VaultKeyBindingV1;
  };
}

/** Build a one-time DecryptGrant for the (already entitlement-approved) read and
 *  verify it through the KAS. Returns the KeyReleaseDecision; `releasedFields`
 *  scopes the subsequent vault decrypt. */
export async function authorizeDecrypt(input: AuthorizeDecryptInput): Promise<KeyReleaseDecision> {
  const now = new Date();
  const ttl = input.ttlSeconds ?? 120;
  // Compute argsHash ONCE and reuse for both the grant and the KAS expectation,
  // so they bind identically regardless of JSON key order.
  const argsHash = await sha256Hex(JSON.stringify(input.args ?? {}));
  const entitlementHashes = await Promise.all((input.entitlementIds ?? []).map((id) => sha256Hex(id)));

  const grant = await createDecryptGrant({
    id: `urn:ap:decrypt-grant:${globalThis.crypto.randomUUID()}`,
    issuer: input.principal,
    audience: input.audience,
    principal: input.principal,
    mcp: { resourceUri: input.audience, serverId: input.serverId, toolName: input.toolName, argsHash },
    authorization: { entitlementHashes },
    vault: {
      vaultId: 'demo-mcp',
      objectIds: [`${input.principal.toLowerCase()}:${input.resource}`],
      resource: input.resource,
      fields: input.allowedFields,
      purpose: input.purpose,
      classificationCeiling: input.classification,
    },
    constraints: {
      ttlSeconds: ttl,
      notBefore: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      oneTimeUse: true,
    },
    replay: { jti: globalThis.crypto.randomUUID() },
  });

  // Fresh per-call replay store — see module note on cross-request grants. The
  // vault-key authorization (spec 278) is checked alongside the grant, BEFORE the
  // one-time JTI is consumed, so a vault-key denial never burns the JTI.
  return verifyDecryptGrant(
    grant,
    {
      audience: input.audience,
      principal: input.principal,
      toolName: input.toolName,
      argsHash,
      resource: input.resource,
      requestedFields: input.allowedFields,
      purpose: input.purpose,
      classification: input.classification,
    },
    {
      now,
      replayStore: createInMemoryReplayStore(),
      // EXT-KA-1: the grant is SELF-AUTHORED in-process just above (it never crosses a trust
      // boundary), so there is no external signature to verify. The real authority gate is the
      // person-SA-signed vaultKeyAuthorization (verified via ERC-1271), supplied below. This is the
      // documented, greppable opt-out — a cross-trust consumer of a client-supplied grant must instead
      // pass verifySignature.
      allowUnsignedGrant: true,
      vaultKeyAuthorization: input.vaultKeyAuthorization,
    },
  );
}
