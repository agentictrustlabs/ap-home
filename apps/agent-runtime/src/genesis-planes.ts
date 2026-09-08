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
import {
  buildCaveat, buildVaultRecordScopeCaveat, encodeTimestampTerms, encodeValueTerms, hashDelegation,
  ROOT_AUTHORITY, buildSessionDelegation, type Caveat, type Delegation,
} from '@agenticprimitives/delegation';

/** The 0x03 approved-hash sentinel — the SA's ERC-1271 approved-hash branch validates these wires. */
const APPROVED = '0x03' as Hex;

const MCP_SERVER_ID = 'demo-mcp';

/** The interactions grant's record scopes — the parity-pinned twin of the Home's list. */
export const GENESIS_INTERACTIONS_SCOPES: ReadonlyArray<{ resources: string[]; ops: Array<'read' | 'write' | 'delete'> }> = [
  { resources: [
    'vault:conversation.index', 'vault:conversation.topic:*', 'vault:message.body:topic:*',
    'vault:inbox.data', 'vault:directory.data', 'vault:relationships.data', 'vault:member.profile:*',
    'vault:org.membership:*', 'vault:org.applications', 'vault:impact-profile', 'vault:capabilities.data',
    'vault:skills.data', 'vault:home.manifest', 'vault:control-events.data', 'vault:coordination.requests',
    'vault:coordination.index', 'vault:coordination.endeavor:*', 'vault:content.*',
    'vault:resolution.requests', 'vault:resolution.grants', 'vault:archetype.assignment', 'vault:payment.receipt:*',
    'vault:household.data',
    // Spec 370 P7 — the person's own recent asks, so "him" can mean whom they just meant.
    'vault:conversation.recent',
  ], ops: ['read', 'write'] },
  { resources: ['vault:archetype.assignment'], ops: ['read', 'write', 'delete'] },
  { resources: ['vault:message.body:dm:*'], ops: ['read'] },
  { resources: ['vault:org.invite:*'], ops: ['read'] },
  { resources: [
    'vault:uupg:attestation', 'vault:uupg:attestations', 'vault:uupg:assessed', 'vault:uupg:coalition',
    'vault:uupg:segment-def', 'vault:uupg:org-profile', 'vault:uupg:strategy', 'vault:uupg:identity',
    'vault:uupg:community', 'vault:uupg:observations',
    'vault:newcity:*', 'vault:family:*', 'vault:field:*',
  ], ops: ['read'] },
  { resources: ['vault:family:*', 'vault:field:*'], ops: ['read', 'write'] },
];

export interface GenesisPlanesEnv {
  DELEGATION_MANAGER?: string;
  TIMESTAMP_ENFORCER?: string;
  VALUE_ENFORCER?: string;
  CHAIN_ID?: string | number;
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
    [buildVaultRecordScopeCaveat(GENESIS_INTERACTIONS_SCOPES.map((g) => ({ server: MCP_SERVER_ID, resources: [...g.resources], ops: [...g.ops] })))],
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
    salt: stewardship.salt + 3n,
    chainId, delegationManager: dm,
    enforcers: { timestamp: ts, value: val },
  });
  const sessionLeaf = { wire: { ...leaf.leaf, signature: APPROVED }, digest: leaf.digest };

  return { interactions, sessionLeaf, delivery, digests: [interactions.digest, sessionLeaf.digest, delivery.digest] };
}
