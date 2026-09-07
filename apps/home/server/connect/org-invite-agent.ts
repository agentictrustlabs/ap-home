// POST /connect/org-invite/agent { org, agent, memberAccessDelegation } — spec 321 W2b (steward-gated).
//
// The IN-APP invite path: the steward invites a KNOWN named agent (no counterfactual needed), so the
// pre-signed org→invitee member-access grant is stored against the invitee's SA in the ORG's vault
// (`org.invite:agent:<sa>` — delegation-gated, never KV). /connect/org-membership looks it up when the
// invitee joins (the inbox Join chip lands them on the channels join card), so both invite paths end
// with the same recorded grant. The grant is only ever honored for its exact delegate — fail-closed.
import type { FnContext } from '../_lib/server-broker';
import { orgVault } from '../lib/org-vault';
import { stewardControl } from './org-invite';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as
    | { org?: string; agent?: string; memberAccessDelegation?: { delegator?: string; delegate?: string; signature?: string }; kin?: string; role?: string }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  const agent = (body?.agent ?? '').toLowerCase();
  const mad = body?.memberAccessDelegation;
  if (!isAddress(org) || !isAddress(agent) || !mad?.signature) return json({ error: 'org + agent + signed memberAccessDelegation required' }, 400);
  if ((mad.delegator ?? '').toLowerCase() !== org) return json({ error: 'memberAccessDelegation delegator must be the org' }, 400);
  if ((mad.delegate ?? '').toLowerCase() !== agent) return json({ error: 'memberAccessDelegation delegate must be the invited agent' }, 400);
  // Each leg says which leg it was. This route answered a well-formed request with an EMPTY 500: any
  // throw — the chain read behind the stewardship check, a vault that was never enabled — arrived as the
  // same blank failure, and the caller could not tell "you may not" from "it broke" from "not set up yet".
  // A store that cannot say what went wrong makes every invitation a guess.
  let control: Awaited<ReturnType<typeof stewardControl>>;
  try {
    control = await stewardControl(env, request, org);
  } catch (e) {
    return json({ error: 'could not verify that you steward this organization', detail: String(e instanceof Error ? e.message : e) }, 502);
  }
  if (!control) return json({ error: 'you must steward this organization to invite' }, 403);

  let vault: Awaited<ReturnType<typeof orgVault>>;
  try {
    // The session and the stewardship wire the gate just verified: `org.invite:agent:<sa>` is an
    // AGENT-KEYED record and fails closed at the agent without both.
    vault = await orgVault(env, org, control.session || undefined, control.stewardship);
  } catch (e) {
    return json({ error: 'could not open the organization vault', detail: String(e instanceof Error ? e.message : e) }, 502);
  }
  if (!vault) return json({ error: 'org vault not enabled — a steward must enable channel/vault storage first' }, 409);
  try {
    // Household facets (spec 368) ride on the record so redemption can put them on the membership. Declarative.
    const kin = typeof body?.kin === 'string' ? body.kin.trim().toLowerCase().slice(0, 40) : '';
    const role = typeof body?.role === 'string' ? body.role.trim().toLowerCase().slice(0, 40) : '';
    await vault.set(`org.invite:agent:${agent}`, { delegation: mad, createdAt: Date.now(), status: 'pending', ...(kin ? { kin } : {}), ...(role ? { role } : {}) });
  } catch (e) {
    return json({ error: 'could not store the invitation in the organization vault', detail: String(e instanceof Error ? e.message : e) }, 502);
  }
  return json({ ok: true });
};
