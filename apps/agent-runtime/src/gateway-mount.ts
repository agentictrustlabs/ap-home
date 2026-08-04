// MOUNTING `PrincipalGatewayDO` — one op, co-resident, vault-injected (ADR-0055 amendment).
//
// The gateway is the target serving plane; `InteractionsDO` is the one that serves today. This is the
// first live traffic to reach the gateway, and it is deliberately ONE READ, so the thing being proven is
// narrow: that the gateway's storage seam diverts on a real request path, not merely in a test.
//
// WHY CO-RESIDENT AND NOT A SECOND DO BINDING. A new `durable_objects` binding would give every principal
// a SECOND addressable DO alongside their `InteractionsDO` — two serving planes for one principal, each
// with its own ordering and its own idea of what has been seen. That is the drift this migration exists to
// end, so it would be a strange way to begin it. Constructed here against the SAME
// `state.storage` trust domain, the gateway is a co-resident object (which is how spec 316 §4.0 describes
// it) and no principal gains a second home. It is also why this is REVERSIBLE: deleting the op deletes the
// mount, with no migration tag to unwind and no addressable object left stranded.
//
// WHAT IT COSTS, SAID PLAINLY. Constructing the gateway runs the `CREATE TABLE IF NOT EXISTS` of every
// store it owns. Those tables are real, and they appear in the InteractionsDO of any principal who calls
// the op — empty, but present. `mountGateway` is therefore LAZY: nothing is constructed until the op runs.
//
// WHAT DOES **NOT** MOVE. The record stays in the owner's MCP vault. The vault seam is injected, so the
// gateway's own DO-SQL vault is never constructed and nothing durable and private lands DO-local — the
// whole point of the amendment. What the gateway contributes is its serving-plane machinery: the cached
// authority verdict and the single-use request id. Both are squarely on the DO-local side of the table
// (caches, request ids), and losing them is a rebuild, never a bereavement.

import type { GatewayDeps } from '@agenticprimitives/fabric/cloudflare';
import { createToolRegistry, buildVaultTools } from '@agenticprimitives/fabric/cloudflare';
import type { DekWrapper, Vault } from '@agenticprimitives/vault';

/**
 * The KEK wrapper the gateway asks for before every tool run.
 *
 * It is UNREACHABLE by construction: `wrapperFor` feeds it to `this.vault(wrapper)`, and an injected vault
 * ignores its argument. So the only way any method here runs is if the injection stopped diverting and the
 * gateway fell back to its own DO-SQL vault — at which point person records would be being written
 * DO-local, silently, and a wrapper that quietly produced a working key would let that happen invisibly.
 *
 * It throws instead. A loud failure on a path that must never execute is worth more than a plausible
 * value: the fallback this guards against is not an outage, it is a custody change nobody decided on, and
 * an outage is the far better way to find out about it.
 */
export function unreachableWrapper(): DekWrapper {
  // Throws SYNCHRONOUSLY, though the interface returns a promise. Deliberate: a rejected promise can be
  // absorbed by an unrelated `.catch()` somewhere up the chain, and being quietly absorbed is the one
  // outcome this must not have. Every real caller `await`s it, so the throw propagates identically.
  const refuse = (): never => {
    throw new Error(
      'PrincipalGatewayDO asked for a DEK wrapper — the injected vault should have made this unreachable. ' +
        'Reaching it means the gateway is about to use its own DO-SQL vault, which would put durable ' +
        'private records DO-local (ADR-0055 amendment).',
    );
  };
  return { generateSessionDataKey: refuse, decryptSessionDataKey: refuse } as unknown as DekWrapper;
}

export interface MountedGatewayInput {
  /** The MCP-backed vault port for this grant — `InteractionsDO.vaultFor(grant)`. THE seam that matters. */
  vault: Vault;
  /**
   * The app's FULL delegation verification, already run. The gateway's `verifyToken` is the cold path that
   * produces the args-independent verdict (A); here the app has done that verification with its own
   * machinery, so this adapts the result rather than re-implementing it. Returning `null` is a refusal.
   */
  verify: (token: string) => Promise<
    { principal: string; sessionKey: string; delegationHash: string; epoch: string; manager: string } | null
  >;
  now?: () => string;
}

/**
 * Build the `GatewayDeps` for a mounted, vault-injected gateway.
 *
 * `exchangeStore` / `interactionStore` are deliberately NOT injected and therefore DO-local — which is
 * allowed only because this op touches neither. The moment an op reaches the exchange stream, the three
 * conditions in the amendment come due (vault-first write, a rebuild in code, a test that wipes and
 * rebuilds), and they are not met yet. Mounting a read that needs none of it is what keeps this step
 * honest rather than a foot in the door.
 */
export function buildMountedGatewayDeps(input: MountedGatewayInput): GatewayDeps {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    async verifyToken(token: string) {
      const v = await input.verify(token);
      return v ? { ...v, verifiedAt: now() } : null;
    },
    async wrapperFor() {
      return unreachableWrapper();
    },
    tools: createToolRegistry(buildVaultTools()),
    vault: () => input.vault,
  };
}
