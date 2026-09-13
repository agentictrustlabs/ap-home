'use client';
// The OIDC relying-app enrollment contract — parsed once from the query, with the grant +
// code-delivery + popup mechanics. Moved VERBATIM from the old App.tsx (spec 230): the
// audit-F3 exact-origin postMessage, PKCE code_challenge passthrough, and popup-vs-redirect
// delivery are load-bearing — do not alter the wire behavior.
//
// SEC-005: the relying-origin allowlist is no longer hardcoded here. It's derived from
// `whitelabel.relyingApps[].redirect_uris` so the two sources cannot drift.
import { CLIENT_DEFAULTS, applyClientDefaults } from '../../lib/client-defaults';
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
// Curated clients resolve synchronously from the bundle; MEMBER-REGISTERED ones are looked up
// once via /connect/client-info and then answer synchronously too (src/lib/relying-clients.ts).
import { knownRelyingClient, primeRelyingClient, relyingOriginAllowed } from '../../lib/relying-clients';
import { writePendingEnroll } from './pending-enroll';
import { sharesProfileName } from '../../lib/new-member';
import { profileNameForConnect } from '../../lib/connect-profile-name';

export interface EnrollReq {
  aud: string; // = client_id
  redirectUri: string; // = redirect_uri (exact-match in the registry)
  state: string;
  name: string; // = agent_name — optional; empty = name-deferred Google connect (spec 257 §11)
  delegate: Address; // the relying site's delegate Smart Account (delegation recipient)
  nonce: string;
  codeChallenge: string; // PKCE S256 challenge
  template: string; // delegation_template: 'site-login' | 'org-create'
  orgBase?: string; // org_create: the org name to create
  purpose?: string; // org_create: app-level purpose tag (e.g. jp-adopter-org) — ADR-0025
  grantOrg?: Address; // org_create: a broker org SA to also grant scoped read (spec 246)
  member?: Address; // workspace-member-invite: the person SA being granted into the workspace (P4)
  existingOrg?: Address; // org_create: reuse an EXISTING org the person stewards — grant from it instead of deploying a new one
  sessionKey?: Address; // spec 270 v4 W2 — the relying app's session-key address; the home signs the DEL-001 leaf for it
  payAmount?: string; // spec 272 — x402 charge amount (atomic units) the relying app requested (tier price); capped by the client's paymentConfig
  subPeriod?: number; // spec 272 recurring — when set, this is a SUBSCRIPTION: the billing-period length (seconds). The home also mints a standing pull mandate.
  collectToken?: string; // spec 272 recurring — owner id_token passed by the owner app for the `subscription-collect` ceremony (authorizes the a2a due/collected calls).
  contentSignerTarget?: string; // spec 266 — the single signing identity (e.g. demo-validator.impact) this `content-signer` ceremony authorizes. Per-custodian: you authorize only the SA you connected as.
  prompt?: string; // OIDC `prompt`: 'select_account'/'login' force the custodian chooser instead of silently reusing the active session (multi-custodian admin must never assume an identity).
  requireNamedAgent?: boolean; // relying app requires a unique Impact name before issuing the grant.
}

// SEC-005: ALLOWED_RELYING_ORIGINS is now derived from whitelabel.relyingApps[].redirect_uris
// via `isAllowedRelyingOrigin` (imported above). The previously-hardcoded array is removed
// to prevent drift between the OIDC client registry and the cross-origin postMessage gate.

export function parseEnrollReq(): EnrollReq | null {
  try {
    const p = new URL(window.location.href).searchParams;
    const clientId = p.get('client_id');
    const redirectUri = p.get('redirect_uri');
    const agentName = p.get('agent_name');
    // `delegate` in the URL is an UNTRUSTED HINT anyway (SEC-001 — /oidc/authorize-grant returns the
    // registry-derived delegate, which overrides this). So a registered client may OMIT it and get the
    // registry value here too (openbook-tyndale sends a plain OIDC request with no delegate — without
    // this default the request wasn't recognized as an enroll at all and the member was never
    // redirected back). Unregistered client + no delegate still returns null.
    const delegate = p.get('delegate') ?? (clientId ? (knownRelyingClient(clientId)?.delegate ?? null) : null);
    const codeChallenge = p.get('code_challenge');
    // `delegation_template` is ours; accept `template` as an alias for plain-OIDC relying apps.
    const template = p.get('delegation_template') ?? p.get('template');
    // spec 257 §11: `agent_name` is OPTIONAL — when absent the OP runs the credential ceremony and
    // (Google) deploys a NAMELESS SA; `sub`/`canonical_agent_id` is the sole load-bearing identity.
    // The other fields stay MANDATORY (client_id, redirect_uri, delegate, code_challenge, template) —
    // with delegate/template satisfiable from the registry/alias as above.
    if (!clientId || !redirectUri || !delegate || !codeChallenge || !template) return null;
    const responseType = p.get('response_type');
    if (responseType && responseType !== 'code') return null; // code flow only (spec 230 §4.1)
    const ccm = p.get('code_challenge_method');
    if (ccm && ccm !== 'S256') return null; // S256 PKCE only
    return {
      aud: clientId,
      redirectUri,
      state: p.get('state') ?? '',
      name: agentName ?? '',
      delegate: delegate as Address,
      nonce: p.get('nonce') ?? '',
      codeChallenge,
      template,
      orgBase: p.get('org_base') ?? undefined,
      purpose: p.get('org_purpose') ?? undefined,
      grantOrg: (p.get('grant_org') as Address) ?? undefined,
      member: (p.get('member') as Address) ?? undefined,
      existingOrg: (p.get('existing_org') as Address) ?? undefined,
      sessionKey: (p.get('session_key') as Address) ?? undefined,
      payAmount: /^\d+$/.test(p.get('pay_amount') ?? '') ? (p.get('pay_amount') as string) : undefined,
      subPeriod: /^\d+$/.test(p.get('sub_period') ?? '') ? Number(p.get('sub_period')) : undefined,
      collectToken: p.get('collect_token') ?? undefined,
      contentSignerTarget: p.get('content_signer_target') ?? undefined,
      prompt: p.get('prompt') ?? undefined,
      requireNamedAgent: p.get('require_named_agent') === 'true' || p.get('require_named_agent') === '1',
    };
  } catch {
    return null;
  }
}

export function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

export function relyingAllowed(redirectUri: string): boolean {
  return relyingOriginAllowed(redirectUri);
}

// ── Standalone grant + delivery (used by the hook AND the Google-resume path) ──────────────
// The Google enrollment path redirects out to the broker, so on return the enroll request is
// no longer in the URL — it's restored from a sessionStorage stash. These module-level helpers
// let that resumed flow finish the ceremony with the SAME wire behavior as the in-page hook.

/** Post to the opener ONLY at the validated relying origin (audit F3 — exact targetOrigin). */
export function postEnrollToOpener(enroll: EnrollReq, msg: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !window.opener || !relyingAllowed(enroll.redirectUri)) return;
  try {
    window.opener.postMessage(msg, new URL(enroll.redirectUri).origin);
  } catch {
    /* ignore */
  }
}

/** Server-minted enrollment-grant ticket (SEC-001). The SPA calls this BEFORE running
 *  the ROOT-credential ceremony so the server has bound `{client_id, redirect_uri,
 *  agent_name, delegate (from REGISTRY), code_challenge, nonce, template}` under a
 *  grant_id. The grant_id + the registry-derived `delegate` come back; the SPA uses
 *  the latter (NOT the URL-supplied `delegate`) when constructing the delegation. */
export async function beginEnrollmentGrant(
  enroll: EnrollReq,
  resolvedName: string,
): Promise<{ grant_id: string; delegate: Address }> {
  // The member's HUMAN name, for a client the REGISTRY scopes for `profile`. This is the one place
  // every grant path passes through — the journey, the recognized fast path, the social resume and
  // org-create all call it — so reading it here is what makes "the app gets a name" true for every
  // credential family instead of whichever one someone remembered to wire.
  //
  // Costs nothing for an unscoped client: `sharesProfileName` is false, and no read happens at all.
  const profileName = sharesProfileName(knownRelyingClient(enroll.aud)) ? await profileNameForConnect() : '';
  const r = await fetch('/oidc/authorize-grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: enroll.aud,
      redirect_uri: enroll.redirectUri,
      nonce: enroll.nonce,
      code_challenge: enroll.codeChallenge,
      code_challenge_method: 'S256',
      agent_name: resolvedName,
      ...(profileName ? { profile_name: profileName } : {}),
      delegation_template: enroll.template,
    }),
  });
  const b = (await r.json().catch(() => ({}))) as { grant_id?: string; delegate?: Address; error?: string };
  if (!r.ok || !b.grant_id || !b.delegate) {
    throw new Error(b.error ?? `authorize-grant failed (HTTP ${r.status})`);
  }
  return { grant_id: b.grant_id, delegate: b.delegate };
}

/** Redeem the grant by presenting the signed delegation. The grant is single-use.
 *  /oidc/grant verifies the delegation's `delegate` matches what was bound at
 *  /authorize-grant time + verifies ERC-1271 + records `oidc-deleg:<digest> → client_id`
 *  so silent re-auth can't replay the delegation against a different client (SEC-002). */
export async function submitEnrollGrant(
  grantId: string,
  delegationWire: unknown,
  org?: unknown,
  sessionDelegation?: unknown,
  paymentDelegation?: unknown,
  settlementHash?: string,
  treasury?: string | null,
  pullDelegation?: unknown,
  /** spec 345 — the self-vault grant riding this same plain sign-in, when the client declares one. */
  selfVaultGrant?: unknown,
): Promise<string> {
  const r = await fetch('/oidc/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_id: grantId, delegation: delegationWire, org, sessionDelegation, paymentDelegation, settlementHash, treasury, pullDelegation, selfVaultGrant }),
  });
  const b = (await r.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!r.ok || !b.code) throw new Error(b.error ?? `grant failed (HTTP ${r.status})`);
  return b.code;
}

/** Deliver the code back: popup → postMessage (exact origin) + close; else full-page ?code&state.
 *  Falls back to a redirect if the popup lost its opener (cross-origin OAuth round-trip). */
export function deliverEnrollCode(enroll: EnrollReq, popupMode: boolean, code: string): void {
  // THE APP'S DEFAULTS, BEFORE THE CODE GOES BACK (`src/lib/client-defaults.ts`): a person connecting from the
  // card room leaves with the card room's skills on their agent and its default coach hired — the first hand
  // has a coach, and nobody is asked to go and set it up. Bounded (a minute) and never fatal: a failure is
  // logged, the code is delivered anyway, and the app's own sheet offers the Coaches page.
  if (code && CLIENT_DEFAULTS[enroll.aud]) {
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    void Promise.race([applyClientDefaults(enroll.aud, (line) => console.log('[client-defaults]', line)).then((o) => { if (o.error) console.warn('[client-defaults]', enroll.aud, o.error); else console.log('[client-defaults]', enroll.aud, 'applied', o.applied, 'skipped', o.skipped); }).catch((e: unknown) => console.warn('[client-defaults]', enroll.aud, e)), deadline])
      .then(() => deliverEnrollCodeNow(enroll, popupMode, code));
    return;
  }
  deliverEnrollCodeNow(enroll, popupMode, code);
}

function deliverEnrollCodeNow(enroll: EnrollReq, popupMode: boolean, code: string): void {
  if (popupMode && typeof window !== 'undefined' && window.opener && relyingAllowed(enroll.redirectUri)) {
    postEnrollToOpener(enroll, { type: 'AC_SUCCESS', state: enroll.state, code });
    window.close();
    return;
  }
  const url = new URL(enroll.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', enroll.state);
  // Carry the MINTING origin (this Home — possibly a `<label>` subdomain we hopped to from a nameless apex
  // enroll) so the relying app exchanges the code + verifies the id_token `iss` HERE, not at the apex it
  // opened. Without this, a hopped popup/redirect breaks the exchange (iss mismatch — wallet/passkey only;
  // social FedCMs server-side and never hops). Read by the relying app's `relayCodeIfPopupReturn` / `?code`
  // return handler (spec 295); harmless to apps that ignore it. (The postMessage path above needs no marker
  // — the opener reads the message's `e.origin`, which IS this minting origin.)
  if (typeof window !== 'undefined') url.searchParams.set('ac_iss', window.location.origin);
  // spec 257: if we ARE a popup but lost our opener (the OAuth IdP — e.g. Google COOP — severs
  // window.opener on the cross-origin round-trip), we can't postMessage the code back. Redirect
  // THIS popup to the relying app with a relay marker so it hands {code,state} to its same-origin
  // opener window (which holds the PKCE verifier) and closes, instead of trying to finish the
  // exchange itself. Marker is only set for popupMode, so the plain full-page redirect (popup
  // blocked / mobile, greenfield 11) is unchanged, and apps that don't handle it just ignore it.
  if (popupMode) url.searchParams.set('ac_relay', '1');
  window.location.href = url.toString();
}

/** spec 272 recurring — deliver a subscription-collection RESULT back to the owner app (no OIDC code).
 *  Popup → postMessage {collected, attempted} + close; else full-page redirect with the result in query. */
export function deliverCollectResult(enroll: EnrollReq, popupMode: boolean, result: { collected: number; attempted: number }, kind?: string): void {
  if (popupMode && typeof window !== 'undefined' && window.opener && relyingAllowed(enroll.redirectUri)) {
    postEnrollToOpener(enroll, { type: 'AC_COLLECT', state: enroll.state, kind, ...result });
    window.close();
    return;
  }
  const url = new URL(enroll.redirectUri);
  url.searchParams.set('collect', '1');
  url.searchParams.set('collected', String(result.collected));
  url.searchParams.set('attempted', String(result.attempted));
  if (kind) url.searchParams.set('collect_kind', kind);
  url.searchParams.set('state', enroll.state);
  window.location.href = url.toString();
}

/** OIDC error bounce (spec 230 §4.3 / prompt=none silent SSO): deliver `?error&state` back to the
 *  relying app with NO UI. Popup → postMessage (exact origin) + close; else full-page redirect.
 *  Standard values a relying app's connect client handles: `login_required` (no home session — the
 *  app clears its silent-SSO hint) / `interaction_required` (a session exists but a silent grant
 *  would mint delegations without a consent gesture) / `access_denied`. */
export function deliverEnrollError(enroll: EnrollReq, popupMode: boolean, error: string): void {
  if (popupMode && typeof window !== 'undefined' && window.opener && relyingAllowed(enroll.redirectUri)) {
    postEnrollToOpener(enroll, { type: 'AC_ERROR', state: enroll.state, error });
    window.close();
    return;
  }
  const url = new URL(enroll.redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('state', enroll.state);
  window.location.href = url.toString();
}

export interface EnrollApi {
  enroll: EnrollReq | null;
  popupMode: boolean;
  allowed: boolean;
  /** True while a MEMBER-REGISTERED client is being looked up. `allowed` is not yet meaningful —
   *  wait, rather than rendering "request blocked" at an app that is in fact registered. */
  resolvingClient: boolean;
  host: string;
  postToOpener(msg: Record<string, unknown>): void;
  /** OIDC error bounce to the relying app (prompt=none outcomes) — see deliverEnrollError. */
  deliverError(error: string): void;
  /** Server-mint the enrollment grant (SEC-001). Returns the grant_id + the canonical
   *  delegate the SPA MUST use when building the delegation (which overrides the
   *  URL-supplied `enroll.delegate` — anti-spoof). Call this BEFORE the ceremony. */
  beginGrant(resolvedName: string): Promise<{ grant_id: string; delegate: Address }>;
  /** Redeem a server-minted grant by presenting the signed delegation. `sessionDelegation` (spec 270 v4
   *  W2) is the DEL-001 leaf the home signed for the relying app's session key — carried to /token. */
  submitGrant(grantId: string, delegationWire: unknown, org?: unknown, sessionDelegation?: unknown, paymentDelegation?: unknown, settlementHash?: string, treasury?: string | null, pullDelegation?: unknown, selfVaultGrant?: unknown): Promise<string>;
  deliverCode(code: string): void;
  denyEnroll(): void;
}

export function useEnrollReq(): EnrollApi {
  const [enroll] = useState<EnrollReq | null>(() => (typeof window === 'undefined' ? null : parseEnrollReq()));
  const [popupMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    // Do NOT require `window.opener`: this Connect origin sets COOP (same-origin-allow-popups), which
    // severs the cross-origin opener as soon as the popup loads us — so `window.opener` is null inside
    // the popup even though we ARE the popup ceremony. `mode=popup` is the reliable signal. Delivery
    // still falls back to the same-origin relay (`ac_relay`) when postMessage can't reach the opener.
    return !!enroll && new URL(window.location.href).searchParams.get('mode') === 'popup';
  });

  // Stash as soon as authorize is parsed — not only when they click Google. A new home that
  // lands on `/` after email/Google must still find this request and finish consent.
  useEffect(() => {
    if (!enroll) return;
    writePendingEnroll({ enroll, popupMode, name: enroll.name ?? '' });
  }, [enroll, popupMode]);

  // RESOLVE BEFORE DECIDING. A member-registered client is not in this bundle, so `allowed`
  // cannot be answered until `/connect/client-info` has replied. `resolvingClient` is true for
  // that window, and the entry screen waits rather than flashing "request blocked" at an app
  // that is perfectly well registered — a false accusation the person cannot act on.
  //
  // A curated client resolves synchronously, so this never delays the common path.
  const [resolvingClient, setResolvingClient] = useState<boolean>(
    () => !!enroll && !knownRelyingClient(enroll.aud),
  );
  const [, setResolvedTick] = useState(0);
  useEffect(() => {
    if (!enroll || knownRelyingClient(enroll.aud)) {
      setResolvingClient(false);
      return;
    }
    let live = true;
    void primeRelyingClient(enroll.aud).finally(() => {
      if (!live) return;
      setResolvingClient(false);
      setResolvedTick((n) => n + 1); // re-read the now-populated origin allowlist
    });
    return () => {
      live = false;
    };
  }, [enroll]);

  // Post to the opener ONLY at the validated relying origin (audit F3 — exact targetOrigin).
  const postToOpener = useCallback(
    (msg: Record<string, unknown>) => {
      if (enroll) postEnrollToOpener(enroll, msg);
    },
    [enroll],
  );

  // Server-mint the enrollment grant (SEC-001 — split from submitGrant so the
  // ceremony runs against the registry-derived delegate, not the URL-supplied one).
  const beginGrant = useCallback(
    async (resolvedName: string): Promise<{ grant_id: string; delegate: Address }> => {
      if (!enroll) throw new Error('no request');
      return beginEnrollmentGrant(enroll, resolvedName);
    },
    [enroll],
  );

  // Redeem the grant by presenting the signed delegation.
  const submitGrant = useCallback(
    async (grantId: string, delegationWire: unknown, org?: unknown, sessionDelegation?: unknown, paymentDelegation?: unknown, settlementHash?: string, treasury?: string | null, pullDelegation?: unknown, selfVaultGrant?: unknown): Promise<string> => {
      return submitEnrollGrant(grantId, delegationWire, org, sessionDelegation, paymentDelegation, settlementHash, treasury, pullDelegation, selfVaultGrant);
    },
    [],
  );

  // Deliver the code back (popup postMessage exact origin; or full-page ?code&state). The
  // token never travels in the URL — only the code.
  const deliverCode = useCallback(
    (code: string) => {
      if (enroll) deliverEnrollCode(enroll, popupMode, code);
    },
    [enroll, popupMode],
  );

  const denyEnroll = useCallback(() => {
    if (!enroll) return;
    if (popupMode) {
      postToOpener({ type: 'AC_CANCEL', state: enroll.state });
      window.close();
      return;
    }
    const url = new URL(enroll.redirectUri);
    url.searchParams.set('enroll_error', 'denied');
    url.searchParams.set('state', enroll.state);
    window.location.href = url.toString();
  }, [enroll, popupMode, postToOpener]);

  const deliverError = useCallback(
    (error: string) => {
      if (enroll) deliverEnrollError(enroll, popupMode, error);
    },
    [enroll, popupMode],
  );

  return {
    enroll,
    popupMode,
    allowed: enroll ? relyingAllowed(enroll.redirectUri) : false,
    resolvingClient,
    host: enroll ? hostOf(enroll.redirectUri) : '',
    postToOpener,
    deliverError,
    beginGrant,
    submitGrant,
    deliverCode,
    denyEnroll,
  };
}

/**
 * CEREMONY templates — the owner-operations that run ON the home session instead of minting a grant
 * for a relying app (content-signer, subscription-collect, service-agent-wire).
 *
 * ONE predicate, because this used to be six hand-written `t === 'a' || t === 'b'` lists spread
 * across EntryExperience, RecognizedEnroll and GoogleEnrollResume, and adding a template meant
 * finding all six. Missing one does not fail loudly: the request quietly completes down the ordinary
 * site-login pipeline — one signature, a bare `?code`, nothing stored — which looks like success from
 * the outside. service-agent-wire was added to three of the six and lost twice to the other three.
 */
export const CEREMONY_TEMPLATES = ['content-signer', 'subscription-collect', 'service-agent-wire'] as const;

/** Templates that deploy a new agent (org or workspace) rather than minting a site-login grant. */
export function isDeployTemplate(template: string | undefined | null): boolean {
  return template === 'org-create' || template === 'workspace-create';
}

export function isCeremonyTemplate(template: string | undefined | null): boolean {
  return !!template && (CEREMONY_TEMPLATES as readonly string[]).includes(template);
}
