// THE IN-WORKER MARKER — how co-resident Durable Objects prove they are in-Worker (spec 341 §7).
//
// WHAT THIS IS NOT. It is not an HMAC, and calling it one has caused real confusion: no signature, no
// nonce, no audience, no freshness window. It is a constant compare of a value only code running inside
// this Worker can read from `env`. That is sufficient for what it guards, because the marker never
// crosses a network boundary — every use is a Durable Object stub fetch, which cannot be reached from
// outside. The public router refuses `internal.*` outright; this is the second, DO-side check that does
// not trust the router (ARCH-H2).
//
// WHY IT GOT ITS OWN VALUE. It used to be `A2A_CUSTODY_BRIDGE_SECRET` — the Home↔demo-a2a custody
// secret — reused for no reason other than that the value was there. The consequence was a blast radius
// that did not match the risk: a leak of the CUSTODY secret also conferred the ability to call
// `internal.deliver`, `internal.dm.body.put` and `internal.channels.post` against ANY principal,
// bypassing every owner gate. Those ops are marker-gated precisely because they are trusted. One value,
// two very different trust levels, twenty-five call sites on the privileged side.
//
// The split is Worker-local by construction: setter and checker are the same deployed code reading the
// same binding, so there is no cross-service coordination and no version skew to manage. The value is
// generated at provisioning time and piped straight to `wrangler secret put` — it is never written to a
// file, never shared with the Home, and never needs rotating in step with anything else.
//
// FAIL-CLOSED, and deliberately NOT falling back to the old secret. A fallback would mean the split had
// not happened: the custody secret would still open these doors, which is the entire thing being fixed.
// Unprovisioned ⇒ every internal op is refused, loudly, rather than quietly accepting the value the
// split exists to stop accepting (ADR-0013).

/** The env shape this needs. Kept structural so tests and both DOs can pass their own `Env`. */
export interface InternalMarkerEnv {
  A2A_INTERNAL_MARKER?: string;
}

/**
 * The marker this deployment uses, or `null` when unprovisioned.
 *
 * An empty string is treated as unset: `wrangler` binds `VAR = ""` as an empty string rather than
 * leaving it undefined, and `??` happily returns it — which would compare `'' === ''` and admit every
 * caller. That exact shape has bitten this repo before.
 */
export function internalMarker(env: InternalMarkerEnv): string | null {
  const v = (env.A2A_INTERNAL_MARKER ?? '').trim();
  return v.length > 0 ? v : null;
}

/** Does this request carry the in-Worker marker? False when unprovisioned — never "no marker configured
 *  therefore allow". */
export function isInternalCall(request: { headers: { get(name: string): string | null } }, env: InternalMarkerEnv): boolean {
  const marker = internalMarker(env);
  if (!marker) return false;
  const presented = request.headers.get('x-ap-internal');
  return typeof presented === 'string' && presented.length === marker.length && presented === marker;
}

/** Headers for an outbound in-Worker call. THROWS when unprovisioned, so a caller cannot send a request
 *  that will be silently refused at the other end and surface as an unrelated failure downstream. */
export function internalHeaders(env: InternalMarkerEnv, extra: Record<string, string> = {}): Record<string, string> {
  const marker = internalMarker(env);
  if (!marker) {
    throw new Error('A2A_INTERNAL_MARKER is not provisioned — in-Worker calls are refused (spec 341 §7)');
  }
  return { 'content-type': 'application/json', 'x-ap-internal': marker, ...extra };
}
