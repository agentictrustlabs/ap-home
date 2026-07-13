// POST /connect/org-applications { org } — spec 324 §7 Tier-2. The steward reads the org's pending
// MembershipApplications (`org.applications` vault doc, via the org's InteractionsDO). Steward-gated
// (controlsOrg). Reading the queue confers nothing; the steward acts on it via /connect/org-decide.
import type { FnContext } from '../_lib/server-broker';
import type { OrgApplication } from '../lib/org-applications';
import { controlsOrg } from './org-invite';
import { bridgeInteractions } from '../lib/interactions-bridge';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { org?: string } | null;
  const org = (body?.org ?? '').toLowerCase();
  if (!isAddress(org)) return json({ error: 'org (SA) required' }, 400);
  if (!(await controlsOrg(env, request, org))) return json({ error: 'you must steward this organization to read its applications' }, 403);
  const r = await bridgeInteractions<{ doc?: { applications?: OrgApplication[] } }>(env, org, 'applications.get', {}).catch(() => null);
  if (r && !r.ok && r.status !== 409) return json({ error: r.body.error ?? `read failed (${r.status})` }, 502);
  const applications = (r?.ok ? r.body.doc?.applications : undefined) ?? [];
  return json({ ok: true, applications });
};
