'use client';
// The OIDC relying-app enrollment contract — parsed once from the query, with the grant +
// code-delivery + popup mechanics. Moved VERBATIM from the old App.tsx (spec 230): the
// audit-F3 exact-origin postMessage, PKCE code_challenge passthrough, and popup-vs-redirect
// delivery are load-bearing — do not alter the wire behavior.
import { useCallback, useState } from 'react';
import type { Address } from '@agenticprimitives/types';

export interface EnrollReq {
  aud: string; // = client_id
  redirectUri: string; // = redirect_uri (exact-match in the registry)
  state: string;
  name: string; // = agent_name (the person to sign in / govern)
  delegate: Address; // the relying site's delegate Smart Account (delegation recipient)
  nonce: string;
  codeChallenge: string; // PKCE S256 challenge
  template: string; // delegation_template: 'site-login' | 'org-create'
  orgBase?: string; // org_create: the org name to create
}

/** Relying sites permitted to start an authorization (demo gate — spec 230 §6 + §8). */
const ALLOWED_RELYING_ORIGINS = ['https://agenticprimitives-demo-org.pages.dev'];

export function parseEnrollReq(): EnrollReq | null {
  try {
    const p = new URL(window.location.href).searchParams;
    const clientId = p.get('client_id');
    const redirectUri = p.get('redirect_uri');
    const agentName = p.get('agent_name');
    const delegate = p.get('delegate');
    const codeChallenge = p.get('code_challenge');
    const template = p.get('delegation_template');
    if (!clientId || !redirectUri || !agentName || !delegate || !codeChallenge || !template) return null;
    const responseType = p.get('response_type');
    if (responseType && responseType !== 'code') return null; // code flow only (spec 230 §4.1)
    const ccm = p.get('code_challenge_method');
    if (ccm && ccm !== 'S256') return null; // S256 PKCE only
    return {
      aud: clientId,
      redirectUri,
      state: p.get('state') ?? '',
      name: agentName,
      delegate: delegate as Address,
      nonce: p.get('nonce') ?? '',
      codeChallenge,
      template,
      orgBase: p.get('org_base') ?? undefined,
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
  try {
    return ALLOWED_RELYING_ORIGINS.includes(new URL(redirectUri).origin);
  } catch {
    return false;
  }
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

/** Turn the verified ceremony into an OIDC authorization code (spec 230 §4.2). */
export async function submitEnrollGrant(
  enroll: EnrollReq,
  resolvedName: string,
  delegationWire: unknown,
  org?: unknown,
): Promise<string> {
  const r = await fetch('/oidc/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: enroll.aud,
      redirect_uri: enroll.redirectUri,
      nonce: enroll.nonce,
      code_challenge: enroll.codeChallenge,
      agent_name: resolvedName,
      delegation_template: enroll.template,
      delegation: delegationWire,
      org,
    }),
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
  window.location.href = url.toString();
}

export interface EnrollApi {
  enroll: EnrollReq | null;
  popupMode: boolean;
  allowed: boolean;
  host: string;
  postToOpener(msg: Record<string, unknown>): void;
  submitGrant(resolvedName: string, delegationWire: unknown, org?: unknown): Promise<string>;
  deliverCode(code: string): void;
  denyEnroll(): void;
}

export function useEnrollReq(): EnrollApi {
  const [enroll] = useState<EnrollReq | null>(() => (typeof window === 'undefined' ? null : parseEnrollReq()));
  const [popupMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return !!enroll && !!window.opener && new URL(window.location.href).searchParams.get('mode') === 'popup';
  });

  // Post to the opener ONLY at the validated relying origin (audit F3 — exact targetOrigin).
  const postToOpener = useCallback(
    (msg: Record<string, unknown>) => {
      if (enroll) postEnrollToOpener(enroll, msg);
    },
    [enroll],
  );

  // Turn the verified ceremony into an OIDC authorization code (spec 230 §4.2): the
  // just-signed delegation IS the proof-of-possession (the grant verifies it via ERC-1271).
  const submitGrant = useCallback(
    async (resolvedName: string, delegationWire: unknown, org?: unknown): Promise<string> => {
      if (!enroll) throw new Error('no request');
      return submitEnrollGrant(enroll, resolvedName, delegationWire, org);
    },
    [enroll],
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
    submitGrant,
    deliverCode,
    denyEnroll,
  };
}
