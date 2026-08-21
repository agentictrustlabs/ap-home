// POST /connect/org-invite/email — a steward invites someone to their org BY EMAIL (spec 315 invite;
// the invitation primitive, email-delivered). Creates a single-use, time-boxed invite token, stores it,
// and emails a join link. The steward must control the org (related-idx, same gate as the inbox/grant).
//
//   body: { org, email }  → { ok, delivery }
//
// The invitation is a bearer claim: whoever redeems the link + confirms that email joins the org as a
// MEMBER (authority-only, ADR-0025). Redemption lives in org-invite-redeem.ts. Email is delivered via the
// gated SendGrid sender (log-only until configured).
import { importJwks, verifyAgentSession, verifyIdToken } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { verifyStewardship } from '../_lib/verify-stewardship';
import type { IncomingDelegation } from '../_lib/verify-delegation';
import { sendEmail, inviteEmail, emailSendingEnabled } from '../_lib/email-sender';
import { emailHash } from '../../src/lib/kv-indexer';
import { orgVault } from '../lib/org-vault';
import { whitelabel } from '../../src/whitelabel/config';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import type { Address } from '@agenticprimitives/types';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { isAllowedRelyingOriginAsync, resolveClient } from '../_lib/oidc-registry';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/** The authenticated caller: the person SA, plus the relying client_id when the ingress was an
 *  app id_token (null for a first-party Home session). The client_id is what scopes an app's
 *  `returnUrl` below — never a grant of authority (stewardship is still re-verified on-chain). */
export type InviteCaller = { person: string; clientId: string | null };

/** Resolve the caller person SA from a Home session OR a registered relying-app id_token
 *  (same ingress as /connect/inbox — e.g. hotspot-tracker / uupg-tracker). */
export async function callerFromInviteAuth(env: FnContext['env'], request: Request): Promise<InviteCaller | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const issOk = ownIssuer(request, env);
  const home = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: issOk });
  if (home.ok) {
    const person = (home.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
    return person ? { person, clientId: null } : null;
  }
  // Relying-app id_token (aud = registered client_id, e.g. uupg-tracker). Signature still pinned
  // to this Home's JWKS; stewardship is re-checked on-chain below — aud alone never grants control.
  let iss: string | undefined, aud: string | undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { iss?: string; aud?: string };
    iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  } catch { return null; }
  if (!iss || !issOk(iss) || !aud || !(await resolveClient(env, aud))) return null;
  const idv = await verifyIdToken(token, { keys, expectedIss: iss, expectedAud: aud });
  if (!idv.ok) return null;
  const sub = (idv.claims.canonical_agent_id ?? idv.claims.sub ?? '') as string;
  const person = (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, clientId: aud } : null;
}

/** Steward-control gate (same as the inbox `?agent` scope): the org is in the person's managed set. */
export async function controlsOrg(env: FnContext['env'], request: Request, org: string): Promise<boolean> {
  const caller = await callerFromInviteAuth(env, request);
  return !!caller && stewardsOrg(env, caller.person, org);
}

async function stewardsOrg(env: FnContext['env'], person: string, org: string): Promise<boolean> {
  // SEC-H2 — authority comes from an ON-CHAIN stewardship delegation, NOT the self-writable KV
  // `relationship` field. The stewardship wire lives in the related link (a cache reconciled from
  // the person's vault relationships.data); we re-verify it against the chain (ERC-1271 by the org +
  // unrevoked + stewardship caveat shape), so a fabricated link can't confer control. A member (who
  // only holds a member-access grant, no stewardship wire) fails closed.
  const raw = await env.AUTH_CODES.get(`related:${person}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { stewardshipDelegation?: IncomingDelegation }) : null;
  return verifyStewardship(env, org.toLowerCase(), person, link?.stewardshipDelegation);
}

/** An invite can name where the invitee continues once they've joined (Field Workspace, a tracker).
 *  CN-1: the URL origin must be a registered relying-app redirect origin — never an attacker-chosen
 *  host. A relying-app id_token may only send people back to THAT app. A Home session (the ceremony
 *  that can mint the member-access grant) may send them to any registered app the steward named. */
async function appReturnUrl(
  env: FnContext['env'],
  clientId: string | null,
  raw: string | undefined,
): Promise<{ url: string; appName: string | null } | null> {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) return null;
  if (clientId) {
    const client = await resolveClient(env, clientId);
    if (!client) return null;
    const origins = new Set(client.redirect_uris.map((u) => { try { return new URL(u).origin; } catch { return ''; } }));
    if (!origins.has(url.origin)) return null;
    return { url: url.toString().slice(0, 500), appName: client.name ?? null };
  }
  if (!(await isAllowedRelyingOriginAsync(env, raw))) return null;
  return { url: url.toString().slice(0, 500), appName: appNameForOrigin(url.origin, null) };
}

function appNameForOrigin(origin: string, prefer: string | null): string | null {
  const hits = whitelabel.relyingApps.filter((app) =>
    app.redirect_uris.some((u) => { try { return new URL(u).origin === origin; } catch { return false; } }),
  );
  const named =
    (prefer ? hits.find((a) => a.client_id === prefer) : undefined)
    ?? hits.find((a) => a.client_id === 'field-app')
    ?? hits[0];
  return named?.name ?? null;
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | {
        org?: string;
        email?: string;
        memberAccessDelegation?: { delegator?: string; delegate?: string; signature?: string };
        /** Where the invitee continues after joining — validated against a registered app origin. */
        returnUrl?: string;
        /** Optional client_id when the steward is on a Home session and naming the destination app. */
        app?: string;
      }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!isAddress(org) || !EMAIL_RE.test(email)) return json({ error: 'org (SA) + valid email required' }, 400);
  const caller = await callerFromInviteAuth(env, request);
  if (!caller || !(await stewardsOrg(env, caller.person, org))) {
    return json({ error: 'you must steward this organization to invite' }, 403);
  }
  const namedApp = caller.clientId ?? (typeof body?.app === 'string' ? body.app : null);
  const returned = await appReturnUrl(env, namedApp, body?.returnUrl);
  if (body?.returnUrl && !returned) return json({ error: 'returnUrl must be an origin registered for your app' }, 400);
  const returnUrl = returned?.url ?? null;
  const appName = returned?.appName ?? (namedApp ? ((await resolveClient(env, namedApp))?.name ?? null) : null);
  /*
    spec 321 W2 — the pre-signed member-access grant (org → the invitee's counterfactual home, from
    /org-invite/predict). REQUIRED, where it used to be optional.

    Without it the invitee gets a working home and no membership: they accept, land in the org, and
    are refused with "this organization has not authorized you to join — an invite (member-access
    grant) or stewardship is required". The invitation looked issued at every step and admitted
    nobody, which is the worst shape a credential-adjacent artifact can take — it fails at the far
    end, to the person who did nothing wrong, long after the steward believed they had invited them.

    An invite that cannot admit is not an invite, so this refuses to mint one.

    WHO CAN SUPPLY IT. Signing org → invitee needs the ORG's custody, reached through the steward's
    credential (`signHashFor(via, orgSA, { token })`). That is a Home session. A RELYING APP cannot
    produce it — it authenticates as the person and holds no custody — so the refusal names the
    ceremony rather than implying the caller did something wrong.
  */
  const mad = body?.memberAccessDelegation;
  if (!mad) {
    return json(
      {
        error:
          'an invitation needs a signed member-access grant, or it creates a home that the organization will not admit. ' +
          'Minting one takes the organization\u2019s custody, reached through the steward\u2019s credential at their Home.',
        code: 'member_access_grant_required',
        org,
      },
      409,
    );
  }
  if ((mad.delegator ?? '').toLowerCase() !== org) return json({ error: 'memberAccessDelegation delegator must be the org' }, 400);

  const orgName = await new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  }).reverseResolve(org as Address).then((n) => (n ? nameLabel(n) : null)).catch(() => null);

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  // spec 323 W2.3 — SELF-DESCRIBING invite: the org SA rides the LINK, and the single record lives
  // in the ORG VAULT (`org.invite:<token>`, KEK-encrypted, delegation-gated) with an explicit
  // `expiresAt` (7d). The old KV `orginvite:<token>→{org}` pointer is GONE — a second Home redeems
  // by reading the org vault at (org, token) directly (portability; no demo-sso-next KV dependency).
  // The vault write is REQUIRED now (not best-effort): without it the invite has no record at all.
  const expiresAt = Date.now() + 60 * 60 * 24 * 7 * 1000;
  const vault = await orgVault(env, org);
  if (!vault) return json({ error: 'org vault storage not enabled — a steward must enable it before inviting' }, 409);
  // `ServerVaultTransport.set` THROWS on refusal, and this call was not guarded — so any vault
  // denial became a bare 500 with no body from the endpoint that creates invitations. A caller
  // could not tell a refusal from an outage, and the steward gate had already passed, so the
  // obvious explanations were all wrong ones. The write is still REQUIRED (an invite with no
  // record is not an invite); what changes is that its failure says so.
  try {
    await vault.set(`org.invite:${token}`, {
      emailHash: await emailHash(email), createdAt: Date.now(), expiresAt, status: 'pending',
      ...(mad ? { memberAccessDelegation: mad } : {}),
      ...(returnUrl ? { returnUrl } : {}),
      ...(appName ? { appName } : {}),
      ...(namedApp ? { app: namedApp } : {}),
      invitedBy: caller.person.toLowerCase(),
    });
  } catch (e) {
    return json(
      { error: `could not record the invitation in the organization's vault: ${e instanceof Error ? e.message : String(e)}` },
      502,
    );
  }

  const join = new URL(`/invite/${token}`, resolveOrigin(request, env));
  join.searchParams.set('o', org);
  if (namedApp) join.searchParams.set('app', namedApp);
  const joinUrl = join.toString();
  const sent = await sendEmail(env, inviteEmail(email, joinUrl, orgName ?? 'the organization', whitelabel.brand.name, appName));
  if (!sent.ok) return json({ error: `could not send invite: ${sent.error}` }, 502);
  return json({ ok: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', joinUrl, ...(appName ? { appName } : {}) });
};
