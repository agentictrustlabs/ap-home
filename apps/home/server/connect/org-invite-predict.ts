// POST /connect/org-invite/predict { org, email } — spec 321 W2 (steward-gated).
//
// Predict the COUNTERFACTUAL person-agent address an email invitee's home will deploy to:
// `SA = f(C_sub(iss='email', sub=sha256(email)), salt 0)` at the CURRENT rotation — the exact
// derivation org-invite-redeem performs at accept. The steward signs the org→invitee member-access
// delegation against this address BEFORE the invitee exists; it activates only if that home deploys
// (a redeem into a different existing home leaves it inert — fail-closed, never re-targeted).
// The raw email is hashed immediately and never stored (blast-zone, spec 315).
import type { FnContext } from '../_lib/server-broker';
import { resolveKmsAgent } from '../_lib/kms-resolve';
import { emailHash, readRotation } from '../../src/lib/kv-indexer';
import { controlsOrg } from './org-invite';

const EMAIL_ISS = 'email'; // matches org-invite-redeem / email-verify

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { org?: string; email?: string } | null;
  const org = (body?.org ?? '').toLowerCase();
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(org) || !EMAIL_RE.test(email)) return json({ error: 'org (SA) + valid email required' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to invite' }, 403);

  const sub = await emailHash(email);
  const rotation = await readRotation(env.AUTH_CODES, EMAIL_ISS, sub);
  const kms = await resolveKmsAgent(env, EMAIL_ISS, sub, rotation);
  if (!kms.ok) return json({ error: `could not derive the invitee's home address: ${kms.reason}` }, 502);
  const agent = kms.agentId.match(/0x[0-9a-fA-F]{40}$/)?.[0];
  if (!agent) return json({ error: 'derived agent id is not an address' }, 502);
  return json({ ok: true, agent, agentId: kms.agentId });
};
