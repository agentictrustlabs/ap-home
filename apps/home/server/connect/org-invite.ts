// POST /connect/org-invite/email — a steward invites someone to their org BY EMAIL (spec 315 invite;
// the invitation primitive, email-delivered). Creates a single-use, time-boxed invite token, stores it,
// and emails a join link. The steward must control the org (related-idx, same gate as the inbox/grant).
//
//   body: { org, email }  → { ok, delivery }
//
// The invitation is a bearer claim: whoever redeems the link + confirms that email joins the org as a
// MEMBER (authority-only, ADR-0025). Redemption lives in org-invite-redeem.ts. Email is delivered via the
// gated SendGrid sender (log-only until configured).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { sendEmail, inviteEmail, emailSendingEnabled } from '../_lib/email-sender';
import { emailHash } from '../../src/lib/kv-indexer';
import { orgVault } from '../lib/org-vault';
import { whitelabel } from '../../src/whitelabel/config';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { nameLabel } from '../../src/lib/domain';
import type { Address } from '@agenticprimitives/types';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/** Steward-control gate (same as the inbox `?agent` scope): the org is in the person's managed set. */
export async function controlsOrg(env: FnContext['env'], request: Request, org: string): Promise<boolean> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return false;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return false;
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.some((a) => a.toLowerCase() === org.toLowerCase())) return false;
  // authority-only members can't invite (custody-shaped action); only stewards.
  const raw = await env.AUTH_CODES.get(`related:${person}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string }) : null;
  return link?.relationship !== 'member';
}

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { org?: string; email?: string; memberAccessDelegation?: { delegator?: string; delegate?: string; signature?: string } }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!isAddress(org) || !EMAIL_RE.test(email)) return json({ error: 'org (SA) + valid email required' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to invite' }, 403);
  // spec 321 W2 — optional pre-signed member-access grant (org → the invitee's counterfactual home,
  // from /org-invite/predict). Reject a grant whose delegator isn't THIS org — never fix up authority.
  const mad = body?.memberAccessDelegation;
  if (mad && (mad.delegator ?? '').toLowerCase() !== org) return json({ error: 'memberAccessDelegation delegator must be the org' }, 400);

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
  await vault.set(`org.invite:${token}`, { emailHash: await emailHash(email), createdAt: Date.now(), expiresAt, status: 'pending', ...(mad ? { memberAccessDelegation: mad } : {}) });

  const joinUrl = `${resolveOrigin(request, env)}/invite/${token}?o=${org}`;
  const sent = await sendEmail(env, inviteEmail(email, joinUrl, orgName ?? 'the organization', whitelabel.brand.name));
  if (!sent.ok) return json({ error: `could not send invite: ${sent.error}` }, 502);
  return json({ ok: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', joinUrl });
};
