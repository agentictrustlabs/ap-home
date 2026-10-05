// POST /connect/org-membership { org, delegation }  (Bearer person session) — spec 321 W1.
//
// Record the membership delegation (member → org) the invitee signed at invite accept:
//   1. merge it into the member's private related link (`related:<person>:<org>` — ADR-0025, the
//      person's own vault credential; created member-shaped if the listing projection hasn't run yet);
//   2. append it to the org's inbound-grant index (`delegated-idx:<org>`) so the steward's Members
//      panel shows a DELEGATING member whose record can be read over the grant (spec 247).
//
// Gates, fail-closed: the session must BE the delegator (the member consents for themselves only),
// and the delegation's delegate must BE the org — a grant for anyone else is rejected, never fixed up.
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import type { Address } from '@agenticprimitives/types';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { orgVault } from '../lib/org-vault';
import { notAnOrganization, workspaceCheck } from '../lib/workspace-governor';
import { parseRoleOffer, roleSlugOf, type RoleOfferV1 } from '../../src/lib/org-role';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization' };
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...cors } });

export const onRequestOptions = async (): Promise<Response> => new Response(null, { status: 204, headers: cors });

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'session required' }, 401);

  const body = (await request.json().catch(() => null)) as
    | {
        org?: string;
        delegation?: { delegator?: string; delegate?: string; signature?: string };
        /** spec 321 W2 — the steward's pre-signed org→member grant, delivered at redeem. */
        memberAccessDelegation?: { delegator?: string; delegate?: string; signature?: string };
        /** spec 321 item-2 — the member's chosen display name (shown on the steward's roster). */
        displayName?: string;
      }
    | null;
  const org = (body?.org ?? '').toLowerCase();
  const d = body?.delegation;
  if (!isAddress(org) || !d?.delegator || !d?.delegate || !d?.signature) {
    return json({ error: 'org (SA) + signed delegation required' }, 400);
  }

  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
  if (!v.ok) return json({ error: 'invalid session' }, 401);
  const person = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!person) return json({ error: 'no person address in token sub' }, 401);

  // The member consents for THEMSELVES, to THIS org — anything else is rejected (fail-closed).
  if (d.delegator.toLowerCase() !== person) return json({ error: 'delegation delegator must be your person agent' }, 403);
  if (d.delegate.toLowerCase() !== org) return json({ error: 'delegation delegate must be the org' }, 403);
  // AND THIS ORG IS AN ORGANIZATION (the owner's rule, 2026-10-02; `../lib/workspace-governor.ts`). A workspace
  // agent is a service and holds no members: a join that names one is refused by name, with the governor when
  // the member's link knows it, so the ceremony that sent it learns where the membership belongs. The naming
  // read is the one this route makes for the member's label anyway, pointed at the target.
  const wsNaming = new AgentNamingClient({
    rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  });
  const ws = await workspaceCheck(env.AUTH_CODES, person, org, () => wsNaming.reverseResolve(org as Address));
  if (ws.workspace) return json(notAnOrganization(ws.governor), 400);
  // W2 mismatch gate: a member-access grant is stored ONLY when it is org→THIS person. A grant to a
  // different (counterfactual) address is inert — dropped here, never re-targeted (ADR-0013).
  // Two delivery channels for the SAME steward-signed artifact, gated identically: the email path
  // POSTs it (redeem handed it to the invitee); the in-app path stored it in the org vault at invite
  // time (`org.invite:agent:<sa>`, spec 321 W2b) — looked up here when none was posted.
  let mad = body?.memberAccessDelegation;
  // Household facets the invitation carried (spec 368) — read from the org's own record, never from the
  // joiner's body: how they are related is the founder's statement, made when they invited.
  let facets: { kin?: string; role?: string } = {};
  // Spec 410 §8 — the organization's side of the membership credential, from the in-app invitation record (the
  // email path hands it over at redeem and the joiner posts it). Returned to the joiner to countersign; nothing
  // here signs for anyone.
  let relationshipOffer: unknown = (body as { relationshipOffer?: unknown } | null)?.relationshipOffer ?? null;
  // Spec 427 §3.3 — THE ROLE THE ORGANIZATION OFFERED, read from ITS invitation record and never from the joiner's
  // body: what somebody does here is the inviter's statement. The organization's own object reads the same record
  // when it writes the membership and is the one that decides (a member cannot record a role they were not
  // offered); this copy is what the roster projection and the answer to the joiner carry.
  let offeredRole: RoleOfferV1 | null = null;
  // ALWAYS looked up now: the role lives only on the organization's record, so a join that posted its own grant
  // and credential offer (the email path) still has something to read there.
  {
    try {
      // spec 341 §5.5b — the invitee CLAIMS the invite addressed to them: `orgVault` routes an
      // `org.invite:agent:*` read to `invite.claim`, where the AGENT derives the key from the session.
      // The address below is not sent — passing one would re-open the hole that op closes.
      const vault = await orgVault(env, org, token);
      const rec = vault ? ((await vault.get(`org.invite:agent:${person}`)) as { delegation?: typeof mad; status?: string; kin?: string; role?: string; relationshipOffer?: unknown; orgRole?: unknown } | null) : null;
      if (rec?.orgRole && rec.status !== 'removed') { const parsed = parseRoleOffer(rec.orgRole); if (parsed.ok) offeredRole = parsed.offer; }
      if (!mad && rec?.delegation && rec.status !== 'removed') mad = rec.delegation;
      if (!relationshipOffer && rec?.relationshipOffer && rec.status !== 'removed') relationshipOffer = rec.relationshipOffer;
      if (rec) facets = { ...(typeof rec.kin === 'string' ? { kin: rec.kin } : {}), ...(typeof rec.role === 'string' ? { role: rec.role } : {}) };
    } catch { /* unreachable — membership still records; the grant can be re-looked-up later */ }
  }
  const madValid = !!mad && (mad.delegator ?? '').toLowerCase() === org && (mad.delegate ?? '').toLowerCase() === person && !!mad.signature;

  // 1. Member-side link: merge into the existing related link (steward links keep their relationship);
  //    create a member-shaped one when the listing projection hasn't landed yet.
  const linkKey = `related:${person}:${org}`;
  const existing = await env.AUTH_CODES.get(linkKey);
  const memberLabel = await new AgentNamingClient({
    rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID,
    registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
  }).reverseResolve(person as Address).catch(() => null);
  if (existing) {
    const link = JSON.parse(existing) as Record<string, unknown>;
    await env.AUTH_CODES.put(linkKey, JSON.stringify({ ...link, membershipDelegation: d, ...(madValid ? { memberAccessDelegation: mad } : {}) }));
  } else {
    const orgName = await new AgentNamingClient({
      rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID,
      registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver,
    }).reverseResolve(org as Address).catch(() => null);
    await env.AUTH_CODES.put(linkKey, JSON.stringify({
      orgAgent: org, orgName: orgName ?? org, purpose: 'org membership', requestedBy: 'home-invite',
      siteDelegation: null, membershipDelegation: d, ...(madValid ? { memberAccessDelegation: mad } : {}),
      proofHash: null, createdAt: Date.now(),
      kind: 'org', parent: person, relationship: 'member',
    }));
    const idxKey = `related-idx:${person}`;
    const idx = JSON.parse((await env.AUTH_CODES.get(idxKey)) ?? '[]') as string[];
    if (!idx.some((a) => a.toLowerCase() === org)) await env.AUTH_CODES.put(idxKey, JSON.stringify([...idx, org]));
  }

  // 2. Org-side inbound-grant index (what the steward's Members panel reads). `orgAgent` is the
  //    DELEGATOR of the grant (historical field name) — here, the member.
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '';
  const dKey = `delegated-idx:${org}`;
  const dIdx = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<{ orgAgent: string; orgName: string; displayName?: string; delegation: unknown }>;
  if (!dIdx.some((x) => x.orgAgent.toLowerCase() === person)) {
    dIdx.push({ orgAgent: person, orgName: memberLabel ?? '', ...(displayName ? { displayName } : {}), delegation: d, ...(facets.kin ? { kin: facets.kin } : {}), ...(facets.role ? { role: facets.role } : {}) });
    await env.AUTH_CODES.put(dKey, JSON.stringify(dIdx));
  }
  // The steward's roster row carries the ORGANIZATION's role beside the household one (spec 427 §3.4) — a
  // projection of the membership record written below, corrected after that write says which role it recorded.
  const projectRole = async (r: { assignedRole: string; roleName?: string; roleDefinitionId?: string } | null): Promise<void> => {
    const rows = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<Record<string, unknown>>;
    const row = rows.find((x) => String(x.orgAgent ?? '').toLowerCase() === person);
    if (!row) return;
    const next = r && r.assignedRole !== 'member' ? { assignedRole: r.assignedRole, ...(r.roleName ? { roleName: r.roleName } : {}), ...(r.roleDefinitionId ? { roleDefinitionId: r.roleDefinitionId } : {}) } : null;
    if (JSON.stringify(row.orgRole ?? null) === JSON.stringify(next)) return;
    if (next) row.orgRole = next; else delete row.orgRole;
    await env.AUTH_CODES.put(dKey, JSON.stringify(rows));
  };
  // 3. THE MEMBERSHIP ITSELF, in the ORGANIZATION's own vault — spec 325's OrganizationMembership
  //    (finding ORG-MEM-1). Steps 1 and 2 record the member's own link and a Home-side index; neither is
  //    the organization's record of whom it admitted, and until this existed no such record was written
  //    anywhere. The org's Members panel read the KV index and looked right; its OWN agent, asked "who
  //    are the members", answered nobody.
  //
  //    Written by the member, for themselves, presenting the grant they just signed — the DO re-checks
  //    that the delegation is TO this org and BY this member, so nothing here is trusted on its word.
  //    Best-effort: the grant has already landed and the membership is real; a failed note costs the
  //    org's own read, not the membership.
  //    REPORTED, not swallowed. A silent catch here made a backfill print "recorded" for four members
  //    whose records were never written — the endpoint's other work had succeeded, so `ok:true` was
  //    true and useless. Best-effort must still say what happened.
  let membershipRecorded = false;
  let membershipError: string | undefined;
  // What the organization's object says it recorded — the role is ITS answer, not what this route sent.
  let recordedRole: { assignedRole: string; roleName?: string; roleDefinitionId?: string } | null = null;
  try {
    const { callInteractions } = await import('./channels');
    const r = await callInteractions(env, org, 'org.recordMembership', {
      session: token,
      record: {
        type: 'ap.org.membership.v1',
        memberAgent: person,
        organizationAgent: org,
        ...(displayName ? { displayName } : {}),
        admittedVia: 'invitation',
        admittedAt: new Date().toISOString(),
        // The ROLE is declarative and authorizes nothing; the DELEGATION is what confers access. Both are
        // named here so a reader can see which role a given grant materialises (aporg:RoleAssignment).
        // A household membership carries its `aphh:` facets beside the generic role (spec 368): the
        // household role and the kinship — declarative, both; the delegation is still the authority.
        // THE ORGANIZATION'S ROLE (spec 427) is named when the invitation offered one — the slug and the definition
        // it points at. The object re-reads its own invitation and stamps the whole role from THAT; what is sent
        // here is only checked against it, so an invitation this route could not read still records its role.
        roleAssignment: {
          assignedRole: offeredRole ? roleSlugOf(offeredRole.roleDefinitionId) : 'member',
          ...(offeredRole ? { roleDefinitionId: offeredRole.roleDefinitionId } : {}),
          materializedByDelegation: d,
          ...(facets.role ? { householdRole: facets.role } : {}), ...(facets.kin ? { kinRelation: facets.kin } : {}),
        },
      },
    });
    membershipRecorded = r.status === 200;
    if (!membershipRecorded) membershipError = JSON.stringify(r.body).slice(0, 200);
    else {
      const b = r.body as { role?: unknown; roleName?: unknown; roleDefinitionId?: unknown };
      if (typeof b.role === 'string' && b.role) recordedRole = { assignedRole: b.role, ...(typeof b.roleName === 'string' ? { roleName: b.roleName } : {}), ...(typeof b.roleDefinitionId === 'string' ? { roleDefinitionId: b.roleDefinitionId } : {}) };
      await projectRole(recordedRole).catch(() => undefined);
    }
  } catch (e) {
    // The membership stands on the signed grant; this is the organization's own note of it.
    membershipError = e instanceof Error ? e.message : String(e);
  }
  const offerFits = !!relationshipOffer && typeof relationshipOffer === 'object' && String((relationshipOffer as { subject?: string }).subject ?? '').toLowerCase() === person && String((relationshipOffer as { object?: string }).object ?? '').toLowerCase() === org;
  // The joiner is told the role and shown its offer (spec 427 §4): the name and description they read, and the
  // skill packs their agent may be equipped with — theirs to accept, on their own Playbook page.
  const roleOffer = offeredRole && recordedRole && recordedRole.roleDefinitionId === offeredRole.roleDefinitionId ? offeredRole : null;
  return json({ ok: true, memberAccess: madValid, membershipRecorded, ...(membershipError ? { membershipError } : {}), ...(offerFits ? { relationshipOffer } : {}), ...(recordedRole ? { role: recordedRole } : {}), ...(roleOffer ? { roleOffer } : {}) });
};
