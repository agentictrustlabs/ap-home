// THE DURABLE MANDATE-USE LEDGER — spec 445 / AUTH-5 (the single-use half of R917-P-3), owner decision 2.
// On chain a step's redemption is consumed under (delegator, delegationHash, kind, stepNonce). A step that never redeems
// (a message, a record, a credential issuance) had no such record: the same mandate + intent + plan verified again in a
// new run until `validUntil`. `delegationMandateVerifier` now REQUIRES this port, and a per-isolate map is not one.
//
// WHERE IT LIVES: Durable Object storage — the claim is one atomic read-then-write inside ONE object (the DO's input
// gate serialises storage operations), it survives a restart, and every isolate that verifies reaches the same object.
// WHICH OBJECT: the `A2aTaskDO` of the mandate's ROOT delegator (the principal whose authority it is). One agent, one
// writer; a mandate is the principal's, so every verifier of it — whatever the run, addressee or isolate — lands on the
// same table. (ADR-0055: this is a serving-plane counter. If it were wiped the cost is a mandate that could be used once
// more before `validUntil`, not a lost record — which is exactly why it is durable rather than in-memory.)
// FAILS CLOSED: no binding, no answer, a non-200 or a malformed answer is a throw — a refusal (`single-use-unrecorded`).
import type { Address, Hex } from 'viem';
import type { MandateUseLedger } from '@agenticprimitives/delegation';
import { internalHeaders } from './internal-marker.js';

/** The internal route on `A2aTaskDO` the ledger calls. */
export const MANDATE_USE_CLAIM_PATH = '/internal/mandate-use/claim';

export type MandateUseEnv = Parameters<typeof internalHeaders>[0] & {
  A2A_TASKS?: DurableObjectNamespace;
};

/** Storage key for one use. Pure; the DO and the tests share it. */
export const mandateUseKey = (mandateRef: string, stepNonce: string): string =>
  `mandate-use:${mandateRef.toLowerCase()}:${stepNonce.toLowerCase()}`;

/** The atomic claim, over a DO storage. true ⇒ `holder` is first, or already holds it; false ⇒ another holder does. */
export async function claimMandateUse(
  storage: Pick<DurableObjectStorage, 'get' | 'put'>,
  use: { mandateRef: string; stepNonce: string; holder: string },
): Promise<boolean> {
  const key = mandateUseKey(use.mandateRef, use.stepNonce);
  const held = (await storage.get(key)) as string | undefined;
  if (held === undefined) { await storage.put(key, use.holder); return true; }
  return held === use.holder;
}

/** The ledger a verifier is built with. `principalOf(mandateRef)` names the root delegator whose object holds the
 *  use (the caller knows the presented wires); `null` ⇒ the use cannot be recorded ⇒ a refusal. */
export function durableMandateUseLedger(env: MandateUseEnv, principalOf: (mandateRef: Hex) => Address | null): MandateUseLedger {
  return {
    async claim({ mandateRef, stepNonce, holder }) {
      const ns = env.A2A_TASKS;
      if (!ns) throw new Error('mandate-use ledger: no A2A_TASKS binding — a use that cannot be recorded is refused');
      const principal = principalOf(mandateRef);
      if (!principal) throw new Error('mandate-use ledger: the mandate names no principal to record its use under');
      const stub = ns.get(ns.idFromName(principal.toLowerCase()));
      const r = await stub.fetch(new Request(`https://a2a-task-do${MANDATE_USE_CLAIM_PATH}`, {
        method: 'POST', headers: internalHeaders(env), body: JSON.stringify({ mandateRef, stepNonce, holder }),
      }));
      const body = (await r.json().catch(() => null)) as { ok?: boolean; first?: boolean } | null;
      if (!r.ok || !body || typeof body.first !== 'boolean') throw new Error(`mandate-use ledger: the claim was not answered (${r.status})`);
      return body.first;
    },
  };
}
