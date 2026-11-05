// POST /oidc/remembered — may this sign-in skip the Allow sheet? (spec 445 §5)
//
// The SERVER decides, proved by the recognition cookie alone: it does not take the session token, so a token stolen and
// replayed from elsewhere cannot collect a person's wires here. A yes signs nothing and sends nothing to the chain but
// reads: the app is handed the wires it was already given, each checked on chain now. A no always carries a reason, and
// the page shows the sheet that reason calls for: an explicit outcome, not a silent fallback (ADR-0013).
//
//   401 { error: 'login_required' }     no live recognition
//   200 { consent_required: <reason> }  the person is known; show the sheet
//   200 { code }                        single-use, PKCE-bound, exactly as /oidc/grant issues one
import { mintIdToken, newAuthCode } from '@agenticprimitives/connect';
import { toCanonicalAgentId } from '@agenticprimitives/identity-directory-adapters';
import { CHAIN_ID, CONTRACTS } from '../../src/lib/chain';
import { covers, isRememberedTemplate, mintsPaymentAtSignIn, termsFor, wireValidUntil, type ConsentTermsV1 } from '../../src/lib/consent-terms';
import { askAsMeCaveats, selfVaultCaveats, siteCaveats } from '../../src/lib/delegation';
import { nameLabel } from '../../src/lib/domain';
import { nameClaimForIdToken, sharesProfileName } from '../../src/lib/new-member';
import { sharesEmailClaim } from '../../src/whitelabel/provisioning';
import type { RelyingApp } from '../../src/whitelabel/schema';
import { readRecognition } from '../_lib/recognition';
import { getServer, json, resolveOrigin, type Env, type FnContext } from '../_lib/server-broker';
import { idTokenTtl } from '../_lib/session-ttl';
import { verifyDelegation, type IncomingDelegation } from '../_lib/verify-delegation';
import { readRows, wireRef, type AppGrantRow } from './app-grant-row';
import { validateGrantRequest, type GrantRequestBody } from './authorize-grant';

const CODE_TTL_SEC = 300;

export type ConsentReason =
  | 'client_not_enabled' | 'template_ineligible' | 'prompt_consent' | 'session_key_requested' | 'via_host_requested'
  | 'session_mismatch' | 'no_record' | 'ask_every_time' | 'pinned_name_mismatch' | 'directory_unavailable' | 'new_origin'
  | 'terms_widened' | 'caveats_changed' | 'wire_revoked' | 'wire_invalid' | 'wire_expiring' | 'chain_unavailable' | 'claims_need_session'
  | 'silent_person_unconfirmed'
  | 'audit_unavailable';

interface RememberedBody extends GrantRequestBody {
  /** The account the page believes is signed in. The cookie decides; this only stops a page showing one person from
   *  completing a sign-in as another when its session and the cookie have come apart. */
  person?: string;
  prompt?: string;
  session_key?: string;
  via_host?: string;
  /** Who the app expects, as an address or CAIP-10. `prompt=none` needs it: see checkRules. */
  login_hint?: string;
}

export interface RuleInput {
  client: RelyingApp;
  template: string;
  prompt?: string;
  sessionKey?: string;
  viaHost?: string;
  /** Lowercase address the cookie proved. */
  person: string;
  pagePerson?: string;
  loginHint?: string;
  row?: AppGrantRow;
  redirectOrigin: string;
  profileName?: string;
  profileEmail?: string;
}

/** Every line of spec 445 §5.2 that needs no chain and no directory, in order. The first that fails names the reason. */
export function checkRules(i: RuleInput): ConsentReason | null {
  if (!isRememberedTemplate(i.template) || mintsPaymentAtSignIn(i.client)) return 'template_ineligible';
  if (i.prompt === 'consent') return 'prompt_consent';
  if (i.sessionKey) return 'session_key_requested';
  // The sheet for a request through a host names that host ("Claude"), so an Allow for one host is not an Allow for another.
  if (i.viaHost) return 'via_host_requested';
  if ((i.pagePerson ?? '').toLowerCase() !== i.person) return 'session_mismatch';
  // A SILENT SIGN-IN SHOWS NOTHING. A code would tell the app who just walked in, and a leftover session would go through
  // unseen. So the app must already name the person it expects, and only that person passes.
  if (i.prompt === 'none' && (i.loginHint ?? '').split(':').pop()?.toLowerCase() !== i.person) return 'silent_person_unconfirmed';
  if (!i.row?.terms) return 'no_record';
  if (i.row.askEveryTime) return 'ask_every_time';
  if (!(i.row.origins ?? []).includes(i.redirectOrigin)) return 'new_origin';
  if (!covers(i.row.terms, termsFor(i.client, i.template))) return 'terms_widened';
  // A blank answer means the page read the profile and there is nothing there. An absent one means it could not read.
  if (sharesProfileName(i.client) && typeof i.profileName !== 'string') return 'claims_need_session';
  if (sharesEmailClaim(i.client) && typeof i.profileEmail !== 'string') return 'claims_need_session';
  return null;
}

export interface WireCheck { wire: IncomingDelegation | undefined; delegate?: string; caveats: ReadonlyArray<{ enforcer: string; terms: string }> }

/** The wires this sign-in's token response would carry, by what the CURRENT registry asks for. */
export function wiresToCheck(row: AppGrantRow, now: ConsentTermsV1): WireCheck[] {
  return [
    { wire: row.delegation, delegate: now.delegates.site, caveats: now.template === 'ask-as-me' ? askAsMeCaveats(1) : siteCaveats(1) },
    ...(now.ask && now.template !== 'ask-as-me' ? [{ wire: row.askDelegation, delegate: now.delegates.ask, caveats: askAsMeCaveats(1) }] : []),
    ...(now.selfVault ? [{ wire: row.selfVaultGrant, caveats: selfVaultCaveats(now.selfVault) }] : []),
  ];
}

/** Does the wire carry what the template builds today? Everything but the time window, which differs by design. A template
 *  that has since narrowed or changed makes an old wire something the person's next Allow should replace. */
export function sameCaveats(wire: IncomingDelegation, built: ReadonlyArray<{ enforcer: string; terms: string }>): boolean {
  const key = (c: { enforcer: string; terms: string }) => `${c.enforcer}:${c.terms}`.toLowerCase();
  const fixed = (cs: ReadonlyArray<{ enforcer: string; terms: string }>) => cs.filter((c) => c.enforcer.toLowerCase() !== (CONTRACTS.timestampEnforcer as string).toLowerCase()).map(key).sort();
  return JSON.stringify(fixed(wire.caveats ?? [])) === JSON.stringify(fixed(built));
}

/** Checks 10 and 11: every wire is this person's, names the registered key, verifies NOW on chain, and outlives the
 *  id_token about to be minted. A wire the person revoked from Connected Apps fails here an instant later. */
export async function checkWires(
  wires: readonly WireCheck[],
  person: string,
  idTokenTtlSec: number,
  nowMs: number,
  verify: (d: IncomingDelegation) => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<ConsentReason | null> {
  for (const { wire, delegate, caveats } of wires) {
    if (!wire) return 'wire_revoked'; // the person revoked it and the row forgot it
    if (wire.delegator?.toLowerCase() !== person) return 'wire_invalid';
    if (delegate && wire.delegate?.toLowerCase() !== delegate.toLowerCase()) return 'wire_invalid';
    if (!sameCaveats(wire, caveats)) return 'caveats_changed';
    const until = wireValidUntil(wire, CONTRACTS.timestampEnforcer);
    if (until !== null && until < nowMs + idTokenTtlSec * 1000) return 'wire_expiring';
  }
  const results = await Promise.all(wires.map(({ wire }) => verify(wire!)));
  for (const r of results) {
    if (r.ok) continue;
    if (/unavailable|chain read failed|retry shortly/i.test(r.reason)) return 'chain_unavailable';
    return /revoked/i.test(r.reason) ? 'wire_revoked' : 'wire_invalid';
  }
  return null;
}

/** Spec 445 W0/W3 — how the decisions are going, by client and day: approximate counters (KV has no increment), for
 *  reading the shadow week with `scripts/remembered-stats.mts`. Never affects the answer. */
async function count(env: Pick<Env, 'AUTH_CODES'>, clientId: string, mode: string, outcome: string): Promise<void> {
  console.info('[remembered]', JSON.stringify({ clientId, mode, outcome }));
  try {
    const key = `remembered-stat:${new Date().toISOString().slice(0, 10)}:${clientId}:${mode}:${outcome}`;
    const n = Number((await env.AUTH_CODES.get(key)) ?? '0');
    await env.AUTH_CODES.put(key, String(n + 1), { expirationTtl: 35 * 86_400 });
  } catch { /* a counter never costs a sign-in */ }
}

/** Audit first (spec 291): a sign-in that cannot be recorded does not skip the sheet. The timeline's event types are a
 *  Ring 0 enum with no word for "no new permission", so Activity reads this short list beside it: a projection of the
 *  audit entry written first, and expiring. The audit log is the record. */
async function recordSignIn(env: Pick<Env, 'AUTH_CODES'>, person: string, clientId: string): Promise<void> {
  const { homeAuditSink } = await import('../../src/home/inbox-data');
  const id = globalThis.crypto.randomUUID();
  const at = new Date().toISOString();
  await homeAuditSink(env.AUTH_CODES as never, person as `0x${string}`).write({
    id, timestamp: at, action: 'home.remembered-sign-in', outcome: 'success',
    actor: { type: 'user', id: person }, subject: { type: 'relying-app', id: clientId },
  } as never);
  const key = `remembered-log:${person}`;
  const rows = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as unknown[];
  await env.AUTH_CODES.put(key, JSON.stringify([{ clientId, at, auditRef: id }, ...rows].slice(0, 100)), { expirationTtl: 90 * 86_400 });
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const iss = resolveOrigin(request, env);
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== iss || (site && site !== 'same-origin')) return json({ error: 'remembered must be called from the home origin' }, 403);

  const body = (await request.json().catch(() => null)) as RememberedBody | null;
  const valid = await validateGrantRequest(env, body);
  if (!valid.ok) return valid.response;
  const { client } = valid;
  const req = body as RememberedBody & { client_id: string; redirect_uri: string; code_challenge: string; delegation_template: string };
  const mode = client.remembered_consent ?? 'off';

  const rec = await readRecognition(request, env.AUTH_CODES);
  const person = (rec?.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!rec || !person) {
    await count(env, req.client_id, mode, 'login_required');
    return json({ error: 'login_required' }, 401);
  }

  const answer = async (reason: ConsentReason, extra: Record<string, unknown> = {}): Promise<Response> => {
    await count(env, req.client_id, mode, reason);
    return json({ consent_required: mode === 'off' ? 'client_not_enabled' : reason, ...extra });
  };

  const row = (await readRows(env.AUTH_CODES, person)).find((r) => r.clientId === req.client_id);
  const failed = checkRules({
    client, template: req.delegation_template, prompt: req.prompt, sessionKey: req.session_key, viaHost: req.via_host,
    person, pagePerson: req.person, loginHint: req.login_hint, row, redirectOrigin: new URL(req.redirect_uri).origin,
    profileName: req.profile_name, profileEmail: req.profile_email,
  });
  if (failed) return answer(failed, failed === 'terms_widened' ? { stored_terms: row?.terms } : {});
  // Off: counted for W0, and the chain is not read for an app that cannot use the answer.
  if (mode === 'off') { await count(env, req.client_id, mode, 'would_check_chain'); return json({ consent_required: 'client_not_enabled' }); }

  const { signer, directory } = await getServer(env);
  // The name on the token comes from the directory, not the page. A pin must be the person the cookie proved.
  let agentName = '';
  try {
    agentName = (await directory.agent(rec.sub as never))?.facets?.name ?? '';
  } catch {
    return answer('directory_unavailable');
  }
  if (req.agent_name && nameLabel(req.agent_name) !== nameLabel(agentName)) return answer('pinned_name_mismatch');

  const now = termsFor(client, req.delegation_template);
  const stored = row as AppGrantRow;
  const ttl = idTokenTtl(env, req.client_id);
  const failedWire = await checkWires(wiresToCheck(stored, now), person, ttl, Date.now(), (d) => verifyDelegation(env, d));
  if (failedWire) return answer(failedWire);

  // Everything held. In shadow the decision is recorded and the sheet is shown anyway.
  if (mode === 'shadow') {
    await count(env, req.client_id, mode, 'allow');
    return json({ consent_required: 'shadow', would: 'allow' });
  }

  try {
    await recordSignIn(env, person, req.client_id);
  } catch (e) {
    console.warn('[remembered] audit failed, showing the sheet:', e instanceof Error ? e.message : String(e));
    return answer('audit_unavailable');
  }

  const profileName = sharesProfileName(client) ? (req.profile_name ?? '').trim().slice(0, 80) : '';
  const profileEmail = sharesEmailClaim(client) ? (req.profile_email ?? '').trim().toLowerCase().slice(0, 254) : '';
  const idToken = await mintIdToken({
    iss,
    sub: toCanonicalAgentId(CHAIN_ID, stored.delegation.delegator),
    aud: req.client_id,
    nonce: req.nonce || undefined,
    agentName: nameClaimForIdToken(agentName, profileName),
    ...(profileEmail ? { email: profileEmail } : {}),
    ...(profileName ? { name: profileName } : {}),
    ttlSeconds: ttl,
  }, signer);

  // The app's silent renewal runs on this binding, exactly as after a sheet.
  await env.AUTH_CODES.put(
    `oidc-deleg:${wireRef(stored.delegation).toLowerCase()}`,
    JSON.stringify({ client_id: req.client_id, agent_name: agentName, profile_name: profileName, profile_email: profileEmail }),
    { expirationTtl: ttl },
  );

  const key = `app-grants:${person}`;
  const rows = await readRows(env.AUTH_CODES, person);
  await env.AUTH_CODES.put(key, JSON.stringify(rows.map((r) => (r.clientId === req.client_id ? { ...r, lastUsedAt: Date.now() } : r))));

  const code = newAuthCode();
  await env.AUTH_CODES.put(`oidc:${code}`, JSON.stringify({
    id_token: idToken,
    delegation: stored.delegation,
    sessionDelegation: null,
    paymentDelegation: null,
    pullDelegation: null,
    settlementHash: null,
    treasury: null,
    charge: null,
    selfVaultGrant: now.selfVault ? stored.selfVaultGrant : null,
    askDelegation: now.ask && now.template !== 'ask-as-me' ? stored.askDelegation : null,
    delegations: null,
    org: null,
    profile_name: profileName,
    code_challenge: req.code_challenge,
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
  }), { expirationTtl: CODE_TTL_SEC });
  await count(env, req.client_id, mode, 'allow');
  return json({ code });
};
