// Standing inbox-delivery delegation — client config (spec 317 §3.2 / W2).
//
// The recipient signs ONE delegation at onboarding authorizing the Home's delivery-service SA to WRITE
// message bodies into the recipient's vault (residency flips to the recipient at delivery, W3). This
// module holds the two config values the onboarding ceremony needs. Everything is GATED on the
// delivery-service SA being operator-provisioned: unset ⇒ activation is inert (no signature, no store),
// so shipping this before the SA exists is deploy-safe (mirrors the KEK being operator-provisioned).
import type { Address } from '@agenticprimitives/types';

/**
 * The Home-operated delivery-service SA — the DELEGATE of the inbox-delivery delegation, and the party
 * that (W3) client-mints a `sub = recipient` token to vault-write inbound bodies. Operator-provisioned
 * (a distinct SA whose session key the Home holds); MUST be DISTINCT from the demo-mcp vault `serverKey`
 * so its authority is exactly the `message.body:*` write grant and nothing else (audit Option X). Unset
 * until provisioned ⇒ `undefined` ⇒ the onboarding activation short-circuits to skipped.
 */
export const DELIVERY_SERVICE_SA: Address | undefined =
  ((process.env.NEXT_PUBLIC_DELIVERY_SERVICE_SA as string | undefined)?.trim() || undefined) as Address | undefined;

/** The demo-mcp resource-server id the record-scope grant binds. Matches demo-mcp's `VAULT_SERVER_ID`;
 *  demo-mcp only honors a `VaultRecordScopeGrant` whose `server` equals this before gating a vault op. */
export const MCP_SERVER_ID = 'demo-mcp';

/** The interactions-execution SA (spec 322 §2 plane B) — the DELEGATE of the per-principal
 *  interactions grant, exercised ONLY by that principal's InteractionsDO (the serialized execution
 *  point). DISTINCT from DELIVERY_SERVICE_SA by design (the security review's two-plane split).
 *  Unset until provisioned ⇒ `undefined` ⇒ the activation short-circuits to skipped (deploy-safe). */
export const INTERACTIONS_SERVICE_SA: Address | undefined =
  ((process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA as string | undefined)?.trim() || undefined) as Address | undefined;
