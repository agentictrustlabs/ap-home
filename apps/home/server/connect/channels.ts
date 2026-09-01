// /connect/channels — PROXY to the org's InteractionsDO (spec 322 W2.3b). The Home no longer
// gates, mutates, or persists channel state: every board operation forwards to the per-principal
// serialized execution point on demo-a2a (`/interactions/<org>/<op>`), which owns the membership
// gate (gate-time ERC-1271 listing re-verification), the steward proof, the audit, and the vault
// writes over the plane-B interactions grant. This route keeps ONLY: session extraction (the DO
// re-verifies it against the broker JWKS), the steward-wire attach (from the person's org link),
// the member-link projection reconcile (a Home-local cache), and response-shape compatibility for
// the existing UI. It retires entirely at W5 (spec 322 §5).
//
// Wire shapes preserved for the UI:
//   GET  ?communityId=…[&channelId=…] → { channels, bodies?, you, orgVaultEnabled, membership, steward }
//   POST { action:'create'|'post', … } → { ok, channelId?|messageId? } | { error }
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient } from '../_lib/oidc-registry';
import { ensureOrgMemberLink } from './membership';
import { orgVault } from '../lib/org-vault';

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
const jsonCors = (body: unknown, request: Request, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

/** The `aud` of a JWT without verifying it (used only to pick which expectedAud to verify against). */
function unverifiedAud(token: string): string | null {
  try {
    const seg = token.split('.')[1] ?? '';
    const aud = JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))).aud;
    return typeof aud === 'string' ? aud : null;
  } catch {
    return null;
  }
}

async function personFrom(request: Request, env: FnContext['env']): Promise<{ person: string; token: string } | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const iss = ownIssuer(request, env);
  // 1) the Home's own portal session (aud = demo-sso).
  let v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: iss });
  // 2) fall back to a REGISTERED relying-app id_token (e.g. skills-app), so an app
  //    can drive the Home's channel ops on the signed-in person's behalf — same
  //    person, same steward-wire lookup, same on-chain gate downstream. Only auds
  //    of registered clients are accepted; everything else is refused.
  if (!v.ok) {
    const aud = unverifiedAud(token);
    if (aud && (await resolveClient(env, aud))) {
      v = await verifyAgentSession(token, { keys, expectedAud: aud, expectedIss: iss });
    }
  }
  if (!v.ok) return null;
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  return person ? { person, token } : null;
}

const a2aBase = (env: FnContext['env']): string | undefined =>
  (env as { A2A_CUSTODY_URL?: string }).A2A_CUSTODY_URL?.replace(/\/$/, '') || undefined;

/** The steward's org→person stewardship wire from their org link — the DO's steward proof. */
export async function stewardWireFor(
  env: FnContext['env'],
  person: string,
  org: string,
  /** The caller's session, which lets a missing KV link be reconciled from its SOURCE. Omit and the
   *  lookup stays KV-only — every caller that has a token should pass it. */
  bearer?: string,
): Promise<unknown | null> {
  const raw = await env.AUTH_CODES.get(`related:${person}:${org}`);
  const link = raw ? (JSON.parse(raw) as { relationship?: string; stewardshipDelegation?: unknown }) : null;
  /*
    THE WIRE DECIDES, NOT THE WORD.

    This used to require `relationship !== 'member'` as well as the wire, and refused outright on an
    explicit member link. Two things were wrong with that:

      IT WAS NOT A CHECK. `relationship` is a display label on a KV projection. The thing that
      authorizes is the delegation, and the DO re-verifies it in full downstream — org-signed via
      ERC-1271, unrevoked on chain, and carrying the stewardship caveat shape (`isSteward`). This
      function only has to FIND the artifact; `memberAccessWireFor` below already says exactly that
      about its own source being untrusted. A label in front of a verified grant adds no safety and
      one more way to be wrong.

      IT WAS A ONE-WAY DOOR. `/connect/related-orgs` makes `relationship` sticky — once `member`,
      always `member` (`body?.relationship === 'member' || existing.relationship === 'member'`). So a
      link demoted to member could never regain library access even after a valid stewardship wire was
      re-issued to it, and no API call could undo that. Withdrawing stewardship has to be reversible
      by re-granting it; anything else makes a demotion an unrecoverable state.

    A member link with no wire still returns null, which is the honest answer — it just comes from the
    wire's absence rather than from the word.
  */
  if (link?.stewardshipDelegation) return link.stewardshipDelegation;

  // SELF-HEAL FROM THE AUTHORITATIVE DOC (spec 323 W1 — the person's `relationships.data` in their
  // own vault is the source; this KV is its projection). The projection is written by several
  // best-effort steps of the org-create ceremony, any of which can fail quietly — and when one does,
  // the org is real, custodied and visible in the portal while every steward-gated call here answers
  // 403. The person cannot fix that from anywhere: the repair is a link only this server writes.
  // Reconciling a projection from its source is not a fallback mechanism (ADR-0013) — the same move
  // `/connect/related-orgs` already makes on the person's own view, and `memberAccessWireFor` below
  // makes from the org vault.
  if (!bearer) return null;
  try {
    const { readRelationshipsDoc } = await import('../lib/relationships-doc');
    const doc = await readRelationshipsDoc(env, person, bearer);
    // Address keys are not case-normalized in the doc (the same reason related-orgs compares with
    // toLowerCase when reconciling) — an exact index would miss a checksummed key and report the
    // person as a non-steward of their own org, which is the bug this exists to fix.
    const entry = Object.entries(doc?.orgs ?? {})
      .find(([k]) => k.toLowerCase() === org.toLowerCase())?.[1];
    // Same rule as above: the wire decides. A relationship word in the authoritative doc is no more
    // a verification than the one in the KV projection.
    if (!entry) return null;
    const wire = Array.isArray(entry.delegations) ? entry.delegations[0] ?? null : null;
    if (!wire) return null;
    await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify({
      ...(link ?? {}),
      orgAgent: org,
      orgName: entry.orgName ?? (link as { orgName?: string } | null)?.orgName ?? org,
      purpose: (link as { purpose?: string } | null)?.purpose ?? 'relationships.data reconcile',
      requestedBy: (link as { requestedBy?: string } | null)?.requestedBy ?? 'home-reconcile',
      relationship: 'steward',
      stewardshipDelegation: wire,
    })).catch(() => undefined);
    return wire;
  } catch {
    return null; // the doc is unreachable (plane not enabled / token can't read it) — KV stands
  }
}

/**
 * The org→person SCOPED DATA wire from their link — the proof a non-steward presents to read.
 *
 * Stewardship is not the only way to reach an organization's records, and treating it as the only one
 * is what made "member" mean "sees nothing". A scoped grant carries a vault-record-scope caveat naming
 * exactly which resources and ops it covers; the DO evaluates that caveat per resource
 * (`hasScopedAccess`), so this only has to FIND the artifact — the same rule `memberAccessWireFor`
 * states about its own source being untrusted.
 *
 * KV ONLY, no reconcile. A missing scoped wire is an answer: this person was never given one. There is
 * nothing to self-heal from, unlike a stewardship projection that the org-create ceremony can drop.
 */
export async function scopedWireFor(env: FnContext['env'], person: string, org: string): Promise<unknown | null> {
  const raw = await env.AUTH_CODES.get(`related:${person}:${org}`);
  if (!raw) return null;
  const link = JSON.parse(raw) as { membershipDelegation?: unknown; memberAccessDelegation?: unknown };
  return link.membershipDelegation ?? link.memberAccessDelegation ?? null;
}

/** The org→person MEMBER-ACCESS wire (SEC-H1) — the ORG's authorization that `person` may join,
 *  minted by the steward at invite time and stored in the org vault at `org.invite:agent:<person>`.
 *  The DO re-verifies it on-chain (ERC-1271 by the org + unrevoked + data-grant scope), so the
 *  SOURCE is untrusted — this only has to FIND the artifact. Falls back to the member's own KV link
 *  (populated after the first join) when the org vault isn't reachable. */
export async function memberAccessWireFor(env: FnContext['env'], org: string, person: string): Promise<unknown | null> {
  try {
    const vault = await orgVault(env, org);
    const rec = vault ? ((await vault.get(`org.invite:agent:${person.toLowerCase()}`)) as { delegation?: unknown; status?: string } | null) : null;
    if (rec?.delegation && rec.status !== 'removed') return rec.delegation;
  } catch { /* vault unreachable — fall to the cached link */ }
  const raw = await env.AUTH_CODES.get(`related:${person.toLowerCase()}:${org.toLowerCase()}`);
  const link = raw ? (JSON.parse(raw) as { memberAccessDelegation?: unknown }) : null;
  return link?.memberAccessDelegation ?? null;
}

/** Forward one op to the org's InteractionsDO (fail-closed: no base ⇒ 503, never a local fallback). */
export async function callInteractions(
  env: FnContext['env'],
  org: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = a2aBase(env);
  if (!base) return { status: 503, body: { error: 'interactions execution point not configured' } };
  const res = await fetch(`${base}/interactions/${org.toLowerCase()}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  const communityId = (url.searchParams.get('communityId') ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);
  void resolveOrigin;

  const channelId = url.searchParams.get('channelId');
  const stewardship = await stewardWireFor(env, who.person, communityId, who.token);
  const r = await callInteractions(env, communityId, channelId ? 'channels.read' : 'channels.list', {
    session: who.token,
    ...(channelId ? { channelId } : {}),
    ...(stewardship ? { stewardship } : {}),
  });
  if (r.status === 409) {
    // 409 has TWO meanings and the UI must tell them apart (no more silent "empty" — the storage is
    // not simply "off"): (a) NO grant yet → first-time Enable; (b) grant STALE because a wave widened
    // the interactions scope → the steward must RE-Enable to re-sign. Both route to the Enable banner,
    // but a stale grant surfaces its reason so the steward knows why an org that "worked" needs it.
    const reason = String((r.body as { error?: string }).error ?? '');
    const stale = /stale/i.test(reason);
    return jsonCors({ channels: [], bodies: {}, you: '', orgVaultEnabled: false, needsReEnable: stale, reason, membership: 'linked', steward: !!stewardship }, request);
  }
  if (r.status !== 200) return jsonCors(r.body, request, r.status);

  // Membership projection reconcile (Home-local cache; the DO just proved the listing).
  let membership: 'linked' | `link-failed: ${string}` = 'linked';
  if (r.body.you && r.body.you !== 'Steward') {
    try { await ensureOrgMemberLink(env, who.person, communityId); }
    catch (e) { membership = `link-failed: ${e instanceof Error ? e.message : String(e)}`; }
  }
  return jsonCors({ ...r.body, orgVaultEnabled: true, membership, steward: r.body.steward === true || !!stewardship }, request);
};

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const who = await personFrom(request, env);
  if (!who) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as
    | { action?: string; communityId?: string; channelId?: string; title?: string; bodyText?: string; participationPolicy?: 'open' | 'restricted'; visibility?: 'public' | 'private'; members?: string[]; personSA?: string; personName?: string; role?: 'facilitator' | 'contributor'; trigger?: 'mention' | 'all'; displayName?: string }
    | null;
  const communityId = (body?.communityId ?? '').trim().toLowerCase();
  if (!communityId) return jsonCors({ error: 'communityId required' }, request, 400);

  const stewardship = await stewardWireFor(env, who.person, communityId, who.token);
  if (body?.action === 'create') {
    // Participation policy (tbox/messaging.ttl): open (every org member participates — derived) or
    // restricted (invite-only, custodian-created). Legacy `visibility` still accepted from old clients.
    const restricted = body.participationPolicy === 'restricted' || body.visibility === 'private';
    const r = await callInteractions(env, communityId, 'channels.create', {
      session: who.token, title: body.title ?? '',
      participationPolicy: restricted ? 'restricted' : 'open',
      ...(restricted ? { members: Array.isArray(body.members) ? body.members : [] } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  if (body?.action === 'post') {
    // The steward proof travels with the write, as it does on every other branch here. Without it the
    // DO's `communityPresence` sees no listing, no member-access grant and no stewardship, and refuses
    // with "join this community first" — so a steward could read the topic, create it, and configure its
    // assistant, but not post in it. `stewardship` was already computed above and simply not passed.
    const r = await callInteractions(env, communityId, 'channels.post', {
      session: who.token, channelId: body.channelId ?? '', bodyText: body.bodyText ?? '',
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  // Assistant playbook (spec 327 §4b, SKILL.md projection) — steward-only authoring pass-through.
  if (body?.action === 'assistantSkillGet' || body?.action === 'assistantSkillPut') {
    const r = await callInteractions(env, communityId, body.action === 'assistantSkillGet' ? 'channels.assistantSkill.get' : 'channels.assistantSkill.put', {
      session: who.token,
      // `records` rides with the playbook: the DO writes them into the org's vault through the same
      // steward-gated act (APP_OWN_NAMESPACE_SEED_SCOPES). Dropping it here meant an org path could
      // never seed its own knowledge base — only the in-Worker sandbox path could.
      ...(body.action === 'assistantSkillPut'
        ? {
            markdown: (body as { markdown?: string }).markdown ?? '',
            ...((body as { records?: unknown }).records ? { records: (body as { records?: unknown }).records } : {}),
          }
        : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  // Org-assistant enablement (spec 327) — steward-only; the DO owns the gate + name capture.
  // spec 329 §7 — the steward's member-routing ceremony + per-topic toggle. Pass-through: the
  // org's InteractionsDO verifies the wire (delegate = the interactions-session key, consult
  // selector only, ERC-1271 + unrevoked) and custodies it; this route only adds the steward proof.
  if (body?.action === 'routingStatus' || body?.action === 'routingEnable' || body?.action === 'routingDisable') {
    const op = { routingStatus: 'consult.routingStatus', routingEnable: 'consult.routingEnable', routingDisable: 'consult.routingDisable' }[body.action]!;
    const b = body as { channelId?: string; delegation?: unknown; maxFanout?: number; clearWire?: boolean };
    const r = await callInteractions(env, communityId, op, {
      session: who.token,
      ...(b.channelId ? { channelId: b.channelId } : {}),
      ...(b.delegation ? { delegation: b.delegation } : {}),
      ...(b.maxFanout !== undefined ? { maxFanout: b.maxFanout } : {}),
      ...(b.clearWire !== undefined ? { clearWire: b.clearWire } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  // spec 334 §6 — the org's auto-work switch (the org agent does the work on its endeavors).
  // Steward-only for enable/disable (the DO gates); status is readable by the steward too.
  if (body?.action === 'autoWorkStatus' || body?.action === 'autoWorkEnable' || body?.action === 'autoWorkDisable') {
    const op = { autoWorkStatus: 'autowork.get', autoWorkEnable: 'autowork.enable', autoWorkDisable: 'autowork.disable' }[body.action]!;
    const r = await callInteractions(env, communityId, op, {
      session: who.token,
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }

  if (body?.action === 'assistantEnable' || body?.action === 'assistantDisable') {
    const r = await callInteractions(env, communityId, body.action === 'assistantEnable' ? 'channels.assistantEnable' : 'channels.assistantDisable', {
      session: who.token, channelId: body.channelId ?? '',
      ...(body.action === 'assistantEnable' ? { trigger: body.trigger === 'all' ? 'all' : 'mention', ...(body.displayName ? { displayName: body.displayName } : {}) } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  // Topic participation ops — straight pass-through; the DO owns the facilitator/participant gates.
  if (body?.action === 'participants' || body?.action === 'invite' || body?.action === 'acceptInvite' || body?.action === 'revokeParticipant') {
    const op = { participants: 'channels.participants', invite: 'channels.invite', acceptInvite: 'channels.acceptInvite', revokeParticipant: 'channels.revokeParticipant' }[body.action]!;
    const r = await callInteractions(env, communityId, op, {
      session: who.token, channelId: body.channelId ?? '',
      ...(body.personSA ? { personSA: body.personSA } : {}),
      ...(body.personName ? { personName: body.personName } : {}),
      ...(body.role ? { role: body.role } : {}),
      ...(stewardship ? { stewardship } : {}),
    });
    return jsonCors(r.body, request, r.status);
  }
  return jsonCors({ error: 'unknown action' }, request, 400);
};
