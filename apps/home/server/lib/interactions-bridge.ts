// Home-server → InteractionsDO reachability (spec 341 §1 — what is LEFT of the bridge).
//
// THE BRIDGE IS GONE. `bridgeInteractions` and its SEC-010 HMAC envelope are deleted: every Home path
// to an owner's `InteractionsDO` now authorizes with the PERSON'S OWN SESSION, or an org's stewardship
// delegation, or a capability the org itself minted. What the secret used to prove — *the caller is our
// Home* — was never the fact any of those operations turned on.
//
// What survives is a reachability check, and it deliberately no longer asks about the secret. Requiring
// a credential these paths do not use would fail closed for a reason that stopped being true, and would
// keep a dead value load-bearing in config long after the code stopped reading it.
//
// `A2A_CUSTODY_BRIDGE_SECRET` still exists in this app for CUSTODY and OIDC (`server/fedcm.ts`,
// `server/_lib/kms-resolve.ts`) — a different channel, out of this migration's scope (§7.1).
export interface InteractionsBridgeEnv {
  A2A_CUSTODY_URL?: string;
}

/** Is the owner's DO reachable at all? The URL, and nothing else — see above. */
export function interactionsBridgeConfigured(env: InteractionsBridgeEnv): boolean {
  return !!env.A2A_CUSTODY_URL?.trim();
}
