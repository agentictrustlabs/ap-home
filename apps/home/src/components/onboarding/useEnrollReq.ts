'use client';
// The OIDC relying-app enrollment contract — parsed once from the query, with the grant +
// code-delivery + popup mechanics. Moved VERBATIM from the old App.tsx (spec 230): the
// audit-F3 exact-origin postMessage, PKCE code_challenge passthrough, and popup-vs-redirect
// delivery are load-bearing — do not alter the wire behavior.
//
// SEC-005: the relying-origin allowlist is no longer hardcoded here. It's derived from
// `whitelabel.relyingApps[].redirect_uris` so the two sources cannot drift.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { isAllowedRelyingOrigin } from '../../lib/oidc-clients';

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
  sessionKey?: Address; // spec 270 v4 W2 — the relying app's session-key address; the home signs the DEL-001 leaf for it
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
    const delegate = p.get('delegate');
    const codeChallenge = p.get('code_challenge');
    const template = p.get('delegation_template');
    // spec 257 §11: `agent_name` is OPTIONAL — when absent the OP runs the credential ceremony and
    // (Google) deploys a NAMELESS SA; `sub`/`canonical_agent_id` is the sole load-bearing identity.
    // The other fields stay MANDATORY (client_id, redirect_uri, delegate, code_challenge, template).
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
      sessionKey: (p.get('session_key') as Address) ?? undefined,
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
  return isAllowedRelyingOrigin(redirectUri);
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
): Promise<string> {
  const r = await fetch('/oidc/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_id: grantId, delegation: delegationWire, org, sessionDelegation, paymentDelegation }),
  });
  const b = (await r.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!r.ok || !b.code) throw new Error(b.error ?? `grant failed (HTTP ${r.status})`);
  return b.code;
}

/** Deliver the code back: popup → postMessage (exact origin) + close; else full-page ?code&state.
 *  Falls back to a redirect if the popup lost its opener (cross-origin OAuth round-trip). */
export function deliverEnrollCode(enroll: EnrollReq, popupMode: boolean, code: string): void {
  if (popupMode && typeof window !== 'undefined' && window.opener && relyingAllowed(enroll.redirectUri)) {
    postEnrollToOpener(enroll, { type: 'AC_SUCCESS', state: enroll.state, code });
    window.close();
    return;
  }
  const url = new URL(enroll.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', enroll.state);
  // spec 257: if we ARE a popup but lost our opener (the OAuth IdP — e.g. Google COOP — severs
  // window.opener on the cross-origin round-trip), we can't postMessage the code back. Redirect
  // THIS popup to the relying app with a relay marker so it hands {code,state} to its same-origin
  // opener window (which holds the PKCE verifier) and closes, instead of trying to finish the
  // exchange itself. Marker is only set for popupMode, so the plain full-page redirect (popup
  // blocked / mobile, greenfield 11) is unchanged, and apps that don't handle it just ignore it.
  if (popupMode) url.searchParams.set('ac_relay', '1');
  window.location.href = url.toString();
}

export interface EnrollApi {
  enroll: EnrollReq | null;
  popupMode: boolean;
  allowed: boolean;
  host: string;
  postToOpener(msg: Record<string, unknown>): void;
  /** Server-mint the enrollment grant (SEC-001). Returns the grant_id + the canonical
   *  delegate the SPA MUST use when building the delegation (which overrides the
   *  URL-supplied `enroll.delegate` — anti-spoof). Call this BEFORE the ceremony. */
  beginGrant(resolvedName: string): Promise<{ grant_id: string; delegate: Address }>;
  /** Redeem a server-minted grant by presenting the signed delegation. `sessionDelegation` (spec 270 v4
   *  W2) is the DEL-001 leaf the home signed for the relying app's session key — carried to /token. */
  submitGrant(grantId: string, delegationWire: unknown, org?: unknown, sessionDelegation?: unknown, paymentDelegation?: unknown): Promise<string>;
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
    async (grantId: string, delegationWire: unknown, org?: unknown, sessionDelegation?: unknown, paymentDelegation?: unknown): Promise<string> => {
      return submitEnrollGrant(grantId, delegationWire, org, sessionDelegation, paymentDelegation);
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

  return {
    enroll,
    popupMode,
    allowed: enroll ? relyingAllowed(enroll.redirectUri) : false,
    host: enroll ? hostOf(enroll.redirectUri) : '',
    postToOpener,
    beginGrant,
    submitGrant,
    deliverCode,
    denyEnroll,
  };
}
