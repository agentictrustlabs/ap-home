// THE PLANES A TEAM IS BORN WITH — folded into the team-create genesis.
//
// A team chartered through the Ask used to exist on chain with NO vault: the genesis deployed it, named
// it and approved the stewardship digest, and stopped. Everything downstream then failed the same way —
// no roster ("the roster could not be read"), no discussions ("auth failed — mcp: auth failed", the
// authenticate shape of never-provisioned), and an "Enable (steward)" button on a screen the member
// looking at it could not press. The Home's org-create provisions these planes; the harness's flow is the
// same custody act and must provision the same planes, in the same signature.
//
// HOW IT RIDES THE ONE SIGNATURE. The genesis already batches `approveHash(stewardshipDigest)` (the 0x03
// approved-hash mechanism, spec 253): the child SA pre-approves a digest inside its own deploy userOp,
// and a wire carrying the 0x03 sentinel later verifies through its ERC-1271 approved-hash branch. The
// three plane digests join that batch — the person who signs the genesis is consenting to the team
// existing WITH storage, which is what "create a team" means to them, not a second decision.
//
// DETERMINISTIC, FOR THE RESUME. A suspended team-create is re-built byte-for-byte and compared against
// what the person signed, so nothing here may be random: salts derive from the stewardship salt (itself
// derived from the intent digest) and the window is the stewardship window.
//
// THE OTHER COPY of the scope list is `buildInteractionsStruct` in demo-sso-next's `lib/delegation.ts`
// (the Home's enable ceremony). Kept as a local literal on both sides — the CONSULT_SKILL precedent —
// and pinned by a cross-app test comparing DECODED scope sets, because two apps that each sign "the
// interactions grant" must mean the same records by it.
import type { Address, Hex } from 'viem';
import { INTERACTIONS_GRANT_CORE_SCOPES, interactionsGrantScopes, type RecordScopeSpec } from '@agenticprimitives/fabric/interactions';
import {
  buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, hashDelegation,
  ROOT_AUTHORITY, buildSessionDelegation, type Caveat, type Delegation,
} from '@agenticprimitives/delegation';

/** The 0x03 approved-hash sentinel — the SA's ERC-1271 approved-hash branch validates these wires. */
const APPROVED = '0x03' as Hex;

import { vaultServerId } from './vault-server-id.js';
import { INTERACTIONS_APP_SCOPES } from '@ap-home/shared';

/** The interactions grant's record scopes: the package CORE (`@agenticprimitives/fabric/interactions`) plus this
 *  product's own namespaces — the ONE list the Home's enable ceremony appends too (`@ap-home/shared`,
 *  spec 399 §4). Nothing here is a local literal any more: a scope added for one app is added for both. */
export const GENESIS_INTERACTIONS_APP_SCOPES: ReadonlyArray<RecordScopeSpec> = INTERACTIONS_APP_SCOPES;
export const GENESIS_INTERACTIONS_SCOPES: ReadonlyArray<RecordScopeSpec> = [...INTERACTIONS_GRANT_CORE_SCOPES, ...GENESIS_INTERACTIONS_APP_SCOPES];

export interface GenesisPlanesEnv {
  DELEGATION_MANAGER?: string;
  TIMESTAMP_ENFORCER?: string;
  VALUE_ENFORCER?: string;
  CHAIN_ID?: string | number;
  VAULT_SERVER_ID?: string;
}

export interface GenesisPlaneWires {
  interactions: { wire: Delegation; digest: Hex };
  sessionLeaf: { wire: Delegation; digest: Hex };
  delivery: { wire: Delegation; digest: Hex };
  /** The digests the genesis userOp must `approveHash` — in this order, after the stewardship's. */
  digests: [Hex, Hex, Hex];
}

/**
 * Build the three plane wires for a child agent, 0x03-stamped, deterministic from the stewardship
 * grant's own (salt, validUntil).
 */
export function buildGenesisPlanes(
  env: GenesisPlanesEnv,
  child: Address,
  interactionsServiceSA: Address,
  deliveryServiceSA: Address,
  sessionKeyAddress: Address,
  stewardship: { salt: bigint; validUntil: number },
): GenesisPlaneWires {
  const chainId = Number(env.CHAIN_ID ?? 84532);
  const dm = env.DELEGATION_MANAGER as Address;
  const ts = env.TIMESTAMP_ENFORCER as Address;
  const val = env.VALUE_ENFORCER as Address;
  if (!dm || !ts || !val) throw new Error('genesis planes: delegation contracts not configured');
  const { validUntil } = stewardship;
  const MCP_SERVER_ID = vaultServerId(env);

  const struct = (delegate: Address, caveats: Caveat[], saltOffset: bigint): { wire: Delegation; digest: Hex } => {
    const d: Delegation = {
      delegator: child, delegate, authority: ROOT_AUTHORITY,
      caveats: [...caveats, buildCaveat(ts, encodeTimestampTerms(0, validUntil)), buildCaveat(val, encodeValueTerms(0n))],
      salt: stewardship.salt + saltOffset, signature: APPROVED,
    };
    return { wire: d, digest: hashDelegation({ ...d, signature: '0x' }, chainId, dm) };
  };

  const interactions = struct(
    interactionsServiceSA,
    [buildVaultRecordScopeCaveat(interactionsGrantScopes(MCP_SERVER_ID, GENESIS_INTERACTIONS_APP_SCOPES))],
    1n,
  );
  // WRITE-ONLY on the mail records (spec 322 W3f) + invite tracking + content artifacts — the Home's
  // delivery-struct shape, and the plane whose absence answered 503 on the first artifact write.
  const delivery = struct(
    deliveryServiceSA,
    [buildVaultRecordScopeCaveat([
      { server: MCP_SERVER_ID, resources: ['vault:message.body:dm:*', 'vault:inbox.data'], ops: ['write'] },
      { server: MCP_SERVER_ID, resources: ['vault:org.invite:*'], ops: ['read', 'write'] },
      { server: MCP_SERVER_ID, resources: ['vault:content.*'], ops: ['read', 'write'] },
    ])],
    2n,
  );
  // The DEL-001 session leaf: without it the grant stores and every vault op answers 409
  // `session_leaf_required` — enabled-looking and unusable (the provision script's own warning).
  const leaf = buildSessionDelegation({
    delegator: child, sessionKeyAddress, validUntil,
    // Spec 408 §2.1 — the session key presents the child's plane wires to the two service agents and nobody else.
    presentsTo: [interactionsServiceSA, deliveryServiceSA],
    salt: stewardship.salt + 3n,
    chainId, delegationManager: dm,
    enforcers: { timestamp: ts, value: val },
  });
  const sessionLeaf = { wire: { ...leaf.leaf, signature: APPROVED }, digest: leaf.digest };

  return { interactions, sessionLeaf, delivery, digests: [interactions.digest, sessionLeaf.digest, delivery.digest] };
}
