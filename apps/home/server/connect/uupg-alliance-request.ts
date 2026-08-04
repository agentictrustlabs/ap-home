// POST /connect/uupg-alliance-request — Home-mediated UUPG org→alliance workflow.
//
// UUPG should not write another principal's workflow document directly. Home verifies the caller's
// stewardship, then appends/updates a typed pending situation inside the TARGET alliance's
// `org.applications` document through the InteractionsDO bridge.
import { importJwks, verifyAgentSession, verifyIdToken } from '@agenticprimitives/connect';
import type { FnContext } from '../_lib/server-broker';
import { getServer, ownIssuer } from '../_lib/server-broker';
import { getClient } from '../../src/lib/oidc-clients';
import { verifyStewardship } from '../_lib/verify-stewardship';
import type { IncomingDelegation } from '../_lib/verify-delegation';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

/** Every session-authorized alliance op goes through here — one place that decides the authority,
 *  rather than three that each repeat it. */
async function allianceOp<T = Record<string, unknown>>(
  env: FnContext['env'], alliance: string, op: string, payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: T & { error?: string; ok?: boolean } }> {
  const { callInteractions } = await import('./channels');
  const r = await callInteractions(env, alliance, op, payload);
  return { ok: r.status < 400 && r.body.ok !== false, status: r.status, body: r.body as T & { error?: string; ok?: boolean } };
}

const sessionOf = (ctx: FnContext): string => (ctx.request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

interface UupgMembershipRequest {
  recordType: 'uupg:membershipRequest';
  id: number;
  subject: string;
  subject_name: string | null;
  alliance_sa: string;
  alliance_name: string | null;
  custodian_sa: string;
  custodian_name: string;
  requested_role: 'member';
  note: string | null;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn';
  created_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
}

function isUupgRequest(x: unknown): x is UupgMembershipRequest {
  const r = x as Partial<UupgMembershipRequest> | null;
  return !!r && r.recordType === 'uupg:membershipRequest' && typeof r.id === 'number' && !!r.subject && !!r.alliance_sa;
}

async function callerSa({ request, env }: FnContext): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (v.ok) return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
  let iss: string | undefined;
  let aud: string | undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { iss?: string; aud?: string };
    iss = typeof payload.iss === 'string' ? payload.iss : undefined;
    aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  } catch { return null; }
  if (!iss || !ownIssuer(request, env)(iss) || !aud || !getClient(aud)) return null;
  const idv = await verifyIdToken(token, { keys, expectedIss: iss, expectedAud: aud });
  if (!idv.ok) return null;
  const sub = (idv.claims.canonical_agent_id ?? idv.claims.sub ?? '') as string;
  return (sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** The caller's stewardship delegation for an org, if they have one — the artifact that authorizes
 *  acting for it, as opposed to the shared secret that merely proved which server called. */
async function stewardshipFor(env: FnContext['env'], person: string, org: string): Promise<unknown | undefined> {
  const raw = await env.AUTH_CODES.get(`related:${person.toLowerCase()}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { stewardshipDelegation?: unknown }) : null;
  return link?.stewardshipDelegation ?? undefined;
}

async function controlsOrgForPerson(env: FnContext['env'], person: string, org: string): Promise<boolean> {
  const raw = await env.AUTH_CODES.get(`related:${person.toLowerCase()}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { stewardshipDelegation?: IncomingDelegation }) : null;
  return verifyStewardship(env, org.toLowerCase(), person.toLowerCase(), link?.stewardshipDelegation);
}

/**
 * spec 341 §5.5a — reachable only by the ALLIANCE's own steward now that `submit` no longer reads.
 * Authorized by the alliance's stewardship delegation, not a shared secret: the secret proved the
 * caller was our Home and nothing about whether this person may act for this alliance.
 */

async function readRows(env: FnContext['env'], alliance: string, session: string, stewardship?: unknown): Promise<{ apps: unknown[]; rows: UupgMembershipRequest[] }> {
  const r = await allianceOp<{ doc?: { applications?: unknown[] } }>(env, alliance, 'applications.get', { session, ...(stewardship ? { stewardship } : {}) });
  if (!r.ok) throw new Error(r.body.error ?? `read failed (${r.status})`);
  const apps = Array.isArray(r.body.doc?.applications) ? r.body.doc!.applications : [];
  return { apps, rows: apps.filter(isUupgRequest) };
}

async function writeRows(env: FnContext['env'], alliance: string, apps: unknown[], rows: UupgMembershipRequest[], session: string, stewardship?: unknown): Promise<void> {
  const keep = apps.filter((x) => !isUupgRequest(x));
  const put = await allianceOp(env, alliance, 'applications.put', { doc: { applications: [...keep, ...rows] }, session, ...(stewardship ? { stewardship } : {}) });
  if (!put.ok) throw new Error(String(put.body.error ?? `write failed (${put.status})`));
}

export const onRequestPost = async (ctx: FnContext): Promise<Response> => {
  const body = (await ctx.request.json().catch(() => null)) as
    | {
        action?: 'submit' | 'list' | 'listMine' | 'decide';
        orgSA?: string; orgName?: string; allianceSA?: string; allianceName?: string; note?: string;
        allianceSAs?: string[]; status?: string; requestId?: number; decision?: 'approved' | 'denied'; reason?: string;
      }
    | null;
  const action = body?.action ?? 'submit';
  const actor = await callerSa(ctx);
  if (!actor) return json({ error: 'connect first' }, 401);

  if (action === 'submit') {
    const org = (body?.orgSA ?? '').toLowerCase();
    const alliance = (body?.allianceSA ?? '').toLowerCase();
    if (!isAddress(org) || !isAddress(alliance)) return json({ error: 'orgSA and allianceSA required' }, 400);
    if (!(await controlsOrgForPerson(ctx.env, actor, org))) return json({ error: 'you must steward the requesting organization' }, 403);
    // spec 341 §5.5a — ADMISSION. This used to READ the alliance's entire application list to dedup —
    // an org's steward enumerating another organization's pending requests, with no authority over it
    // — and then rewrite the whole document over the shared secret. Both are gone: the applying org's
    // agent sends `org.apply`, and the ALLIANCE's own grant appends, deduping by subject on its side.
    // The applicant never sees the queue it is joining.
    const record = {
      recordType: 'uupg:membershipRequest',
      id: Date.now() * 1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 1000,
      subject: org,
      subject_name: body?.orgName ?? null,
      alliance_sa: alliance,
      alliance_name: body?.allianceName ?? null,
      custodian_sa: actor,
      custodian_name: body?.orgName ?? 'org custodian',
      requested_role: 'member',
      note: body?.note ?? null,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    const sent = await allianceOp(ctx.env, org, 'messaging.send', {
      session: sessionOf(ctx),
      recipient: alliance,
      skill: 'org.apply',
      applicationMessage: body?.note?.trim() || `${body?.orgName ?? 'An organization'} requests to join this alliance.`,
      subject: org,
      record,
    });
    if (!sent.ok) {
      return json({ error: sent.body.error ?? 'request failed', code: (sent.body as { code?: string }).code }, sent.status >= 400 ? sent.status : 502);
    }
    return json({ ok: true });
  }

  if (action === 'list') {
    const alliance = (body?.allianceSA ?? '').toLowerCase();
    if (!isAddress(alliance)) return json({ error: 'allianceSA required' }, 400);
    if (!(await controlsOrgForPerson(ctx.env, actor, alliance))) return json({ error: 'you must steward the alliance' }, 403);
    const { rows } = await readRows(ctx.env, alliance, sessionOf(ctx), await stewardshipFor(ctx.env, actor, alliance));
    const status = body?.status ?? 'pending';
    return json({ ok: true, requests: rows.filter((r) => r.status === status).sort((a, b) => b.id - a.id).slice(0, 200) });
  }

  if (action === 'listMine') {
    const org = (body?.orgSA ?? '').toLowerCase();
    const alliances = (body?.allianceSAs ?? []).map((s) => String(s).toLowerCase()).filter(isAddress);
    if (!isAddress(org)) return json({ error: 'orgSA required' }, 400);
    if (!(await controlsOrgForPerson(ctx.env, actor, org))) return json({ error: 'you must steward the requesting organization' }, 403);
    const all: UupgMembershipRequest[] = [];
    for (const alliance of alliances) {
      // spec 341 §5.6 — the ALLIANCE decides what to show. This used to read the alliance's WHOLE
      // pending list as the requesting org's steward — who has no authority over that alliance — and
      // filter afterwards, so the decision happened here, after an unauthorized read, and a filter bug
      // was a disclosure rather than a denial. Now the alliance's own agent returns only rows belonging
      // to orgs this caller can PROVE they steward; the rest never leaves it.
      const mine = await allianceOp<{ applications?: unknown[] }>(ctx.env, alliance, 'applications.mine', {
        session: sessionOf(ctx),
        subjects: [org],
        stewardship: await stewardshipFor(ctx.env, actor, org),
      }).catch(() => null);
      const rows = (mine?.ok ? (mine.body.applications ?? []) : []).filter(isUupgRequest);
      all.push(...rows);
    }
    return json({ ok: true, requests: all.sort((a, b) => b.id - a.id).slice(0, 200) });
  }

  if (action === 'decide') {
    const alliance = (body?.allianceSA ?? '').toLowerCase();
    const id = Number(body?.requestId ?? 0);
    const decision = body?.decision;
    if (!isAddress(alliance) || !id || (decision !== 'approved' && decision !== 'denied')) return json({ error: 'allianceSA, requestId, decision required' }, 400);
    if (!(await controlsOrgForPerson(ctx.env, actor, alliance))) return json({ error: 'you must steward the alliance' }, 403);
    const allianceWire = await stewardshipFor(ctx.env, actor, alliance);
    const { apps, rows } = await readRows(ctx.env, alliance, sessionOf(ctx), allianceWire);
    const row = rows.find((r) => r.id === id && r.status === 'pending');
    if (!row) return json({ error: 'request_not_pending' }, 404);
    row.status = decision;
    row.decided_at = new Date().toISOString();
    row.decided_by = actor;
    if (decision === 'denied' && body?.reason) row.note = `${row.note ?? ''}${row.note ? ' | ' : ''}denied: ${body.reason}`;
    await writeRows(ctx.env, alliance, apps, rows, sessionOf(ctx), allianceWire);
    return json({ ok: true, request: row });
  }

  return json({ error: 'unknown action' }, 400);
};
