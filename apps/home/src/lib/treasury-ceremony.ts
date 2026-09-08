// The /choose-treasury contract, as pure functions.
//
// WHY IT IS HERE AND NOT IN THE PAGE. Two of the three things this ceremony does are decisions, not
// rendering: whether to proceed at all, and what URL the member leaves on. Both are the kind of
// thing that is either right or an open redirect, and neither can be tested inside a React tree
// that needs a session, a chain read and a signed userOp to reach them. So they live here, pure and
// covered (the same split `lib/invitation-check.ts` uses for the visibility pane), and the page is
// left with the part that genuinely is rendering.
//
// Nothing in this module trusts its input. `parseTreasuryRequest` reads a URL a relying app wrote;
// `refusalFor` is the ONLY function that says yes.

/** An OIDC client as the gates read it — the fields this ceremony needs, structurally typed so the
 *  curated white-label entry and a member registration are both accepted without an import. */
export interface TreasuryCeremonyClient {
  client_id: string;
  name?: string;
  redirect_uris: string[];
}

/** The request as it arrived. Nothing here is trusted until `refusalFor` has answered null. */
export interface TreasuryRequest {
  clientId: string;
  redirectUri: string;
  /** Opaque to this Home; echoed back byte-for-byte, empty string included. */
  state: string;
  /** OPTIONAL name the app suggests for a NEW account. A prefill only — nameless is legitimate. */
  label: string;
}

/** Which gate refused. Named so the refusal screen can say it instead of "something went wrong". */
export type TreasuryRefusalCheck = 'params' | 'client_id' | 'redirect_uri';

export interface TreasuryRefusal {
  check: TreasuryRefusalCheck;
  detail: string;
}

/** How the member came by the treasury they are leaving with. Both values go back to the app. */
export type TreasuryOrigin = 'chosen' | 'created';

/**
 * Read the request out of the ceremony URL.
 *
 * `client_id` and `redirect_uri` are the two that must be present: without the first there is no
 * app to name, and without the second there is nowhere to answer. `state` and `label` default to
 * empty rather than being rejected — an app with no request-matching state and an app that suggests
 * no name are both making a perfectly ordinary request.
 */
export function parseTreasuryRequest(href: string): TreasuryRequest | null {
  let p: URLSearchParams;
  try {
    p = new URL(href).searchParams;
  } catch {
    return null;
  }
  const clientId = (p.get('client_id') ?? '').trim();
  const redirectUri = (p.get('redirect_uri') ?? '').trim();
  if (!clientId || !redirectUri) return null;
  return { clientId, redirectUri, state: p.get('state') ?? '', label: (p.get('label') ?? '').trim() };
}

/**
 * The gate. Returns the refusal, or null when the request may proceed.
 *
 * `client` is what the registry resolved for `req.clientId` — curated entry first, then the member
 * registry, which is `resolveClient`'s order and `primeRelyingClient`'s in the browser. `null` means
 * unknown, disabled, or unresolvable; all three refuse, because to a member they mean the same thing.
 *
 * The redirect check is an EXACT string match against the registered list (CN-1) — the identical
 * predicate `/oidc/authorize-grant` and `/token` apply, and deliberately not an origin check. An
 * origin check would accept `https://app.example/anything`, and "anywhere on that host" is the
 * looser thing this convention exists to refuse.
 */
export function refusalFor(
  req: TreasuryRequest | null,
  client: TreasuryCeremonyClient | null,
): TreasuryRefusal | null {
  if (!req) return { check: 'params', detail: 'client_id and redirect_uri are both required.' };
  if (!client) return { check: 'client_id', detail: `no registered client "${req.clientId}"` };
  if (!client.redirect_uris.includes(req.redirectUri)) {
    return { check: 'redirect_uri', detail: 'that return address is not registered for this app' };
  }
  return null;
}

/**
 * The URL the member leaves on when they have answered.
 *
 * Shaped like the authorize flow's own return: the result, plus `state` echoed back unchanged. The
 * treasury goes back as its ADDRESS because that is its canonical id — a name is optional and may
 * not exist, so an app that keyed off the name would break on exactly the accounts this ceremony
 * makes by default.
 *
 * `redirectUri` MUST be one `refusalFor` has already cleared. Building a URL is not a check, and
 * this function performs none: the whole point of CN-1 is that the verification happened first.
 */
export function treasuryReturnUrl(
  redirectUri: string,
  state: string,
  result: { treasury: string; origin: TreasuryOrigin } | { error: 'denied' },
): string {
  const url = new URL(redirectUri);
  if ('error' in result) {
    // Mirrors the enroll deny's `enroll_error=denied` — a declined ceremony is an answer, not a
    // failure, and the app needs to tell it apart from a member who never arrived.
    url.searchParams.set('treasury_error', result.error);
  } else {
    url.searchParams.set('treasury', result.treasury);
    url.searchParams.set('treasury_status', result.origin);
  }
  url.searchParams.set('state', state);
  return url.toString();
}
