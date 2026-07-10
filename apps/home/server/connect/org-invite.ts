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
async function controlsOrg(env: FnContext['env'], request: Request, org: string): Promise<boolean> {
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
  const body = (await request.json().catch(() => null)) as { org?: string; email?: string } | null;
  const org = (body?.org ?? '').toLowerCase();
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!isAddress(org) || !EMAIL_RE.test(email)) return json({ error: 'org (SA) + valid email required' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to invite' }, 403);

  const orgName = await new AgentNamingClient({
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URL, chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  }).reverseResolve(org as Address).then((n) => (n ? nameLabel(n) : null)).catch(() => null);

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  // KV: capability pointer ONLY — random token → public org SA. NO invitee PII (blast-zone, spec 315).
  await env.AUTH_CODES.put(`orginvite:${token}`, JSON.stringify({ org }), { expirationTtl: 60 * 60 * 24 * 7 });
  // Org vault: the tracking record (invitee email HASH — never raw — + status), encrypted under the org's
  // KEK, delegation-gated. Best-effort: a bearer invite is fully usable from the KV pointer alone; this is
  // the org's own "who did I invite" tracking, kept OUT of KV so an infra leak exposes no invitee data.
  try {
    const vault = await orgVault(env, org);
    if (vault) await vault.set(`org.invite:${token}`, { emailHash: await emailHash(email), createdAt: Date.now(), status: 'pending' });
  } catch { /* tracking is best-effort; the invite remains valid via the KV pointer */ }

  const joinUrl = `${resolveOrigin(request, env)}/invite/${token}`;
  const sent = await sendEmail(env, inviteEmail(email, joinUrl, orgName ?? 'the organization', whitelabel.brand.name));
  if (!sent.ok) return json({ error: `could not send invite: ${sent.error}` }, 502);
  return json({ ok: true, delivery: emailSendingEnabled(env) ? 'sent' : 'logged', joinUrl });
};
