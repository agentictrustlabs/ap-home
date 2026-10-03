// GET /connect/related-orgs?client_id=<id>  (spec 246 / ADR-0025)
//
// Person-session-authorized: the relying app presents the connected person's id_token
// (Authorization: Bearer, or ?id_token=). We verify it against the broker JWKS, pin the
// audience to the calling `client_id`, extract the person SA from the session `sub`, and
// return that person's related-agent links scoped to this client_id — from the private
// Connect-home vault (KV). person↔org never travels as public graph state.
import { createPublicClient, http, keccak256, toBytes, type Hex, type Address } from 'viem';
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
import { buildCustodyDescriptor, relatedAgentWriteContentHash, hashRelatedAgentWriteChallenge, type CustodyDescriptor } from '@agenticprimitives/related-agents';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { getServer, resolveOrigin, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient } from '../_lib/oidc-registry';

/** The `aud` of a JWT without verifying it (only used to pick which expectedAud to verify against). */
function unverifiedAud(token: string): string | null {
  try {
    const aud = JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))).aud;
    return typeof aud === 'string' ? aud : null;
  } catch {
    return null;
  }
}
import { CHAIN_ID, CONTRACTS, DEFAULT_RPC_URL } from '../../src/lib/chain';
import { ERC1271_MAGIC_VALUE as ERC1271_MAGIC } from '@agenticprimitives/types';
// (importJwks / verifyAgentSession / getServer / resolveOrigin are also used by the
//  spec-275 session-authorized POST branch below — same verifier as the GET.)

const ERC1271_ABI = [
  { type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] },
] as const;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  return origin && isAllowedClientOrigin(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', vary: 'Origin' }
    : {};
}
function jsonCors(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(request) } });
}

export const onRequestOptions = async ({ request }: FnContext): Promise<Response> =>
  new Response(null, { status: 204, headers: cors(request) });

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const url = new URL(request.url);
  // `client_id` present → a RELYING app's scoped view (orgs it requested; token aud = client_id).
  // `client_id` absent  → the PERSON's OWN home view (ALL their orgs; token aud = the home aud).
  const clientId = url.searchParams.get('client_id');
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('id_token') ?? '';
  if (!token) return jsonCors({ error: 'id_token required' }, request, 400);

  const iss = resolveOrigin(request, env);
  const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  let v = await verifyAgentSession(token, { keys, expectedAud: clientId ?? homeAud, expectedIss: ownIssuer(request, env) });
  // Person's-own-view (no client_id): also accept a REGISTERED relying-app token (e.g.
  // skills-app), so an app can list the connected person's own orgs — same person, their
  // own links. Mirrors the /connect/channels relying-token fallback.
  if (!v.ok && !clientId) {
    const aud = unverifiedAud(token);
    if (aud && (await resolveClient(env, aud))) v = await verifyAgentSession(token, { keys, expectedAud: aud, expectedIss: ownIssuer(request, env) });
  }
  if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);

  const custodian = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
  if (!custodian) return jsonCors({ error: 'no person address in token sub' }, request, 401);
  // `for=<address>` — THE LINKS OF A PERSONA OF THIS CUSTODIAN (owner, 2026-10-01: the trust graph centred on
  // jenna-alice must show what SHE stewards and belongs to, not alice's tree). Allowed only when the custodian's own
  // tree lists that agent as a person of theirs (`relationship: self`, the charter ceremony's record); any other
  // address is refused by name. The vault reconcile below is the session's own and is skipped for a persona view.
  const forRaw = (url.searchParams.get('for') ?? '').trim().toLowerCase();
  let person = custodian;
  if (forRaw) {
    if (clientId) return jsonCors({ error: 'for= is the person\'s own view, not a relying app\'s' }, request, 400);
    if (!/^0x[0-9a-f]{40}$/.test(forRaw)) return jsonCors({ error: 'for must be an agent address' }, request, 400);
    const raw = await env.AUTH_CODES.get(`related:${custodian}:${forRaw}`);
    const link = raw ? (JSON.parse(raw) as { kind?: string; relationship?: string; status?: string }) : null;
    if (!link || (link.kind ?? '').toLowerCase() !== 'person' || (link.relationship ?? '').toLowerCase() !== 'self') return jsonCors({ error: 'not a person of yours — your Home lists no person-class agent of yours at that address' }, request, 403);
    person = forRaw;
  }

  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];

  // spec 323 W1 — the vault doc (`relationships.data`, via the person's DO) is AUTHORITATIVE; this
  // KV is its projection. On the person's OWN home view (bearer aud = home), reconcile the
  // projection from the source: any org present in the vault doc but missing here gets a KV link
  // synthesized (self-heal — a second app's writes surface everywhere). Reconciling a projection
  // from its source is not a fallback mechanism (ADR-0013).
  if (!clientId && !forRaw) {
    // Reconcile from the authoritative vault doc when the token can read it. Best-effort:
    // a relying token may lack the vault-read scope — the KV projection below still serves.
    const { readRelationshipsDoc } = await import('../lib/relationships-doc');
    const doc = await readRelationshipsDoc(env, person, token).catch(() => null);
    for (const [org, entry] of Object.entries(doc?.orgs ?? {})) {
      if (idx.some((a) => a.toLowerCase() === org.toLowerCase())) continue;
      const wire = Array.isArray(entry.delegations) ? entry.delegations[0] ?? null : null;
      await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify({
        orgAgent: org,
        orgName: entry.orgName ?? org,
        purpose: 'vault relationships.data reconcile',
        requestedBy: 'home-reconcile',
        siteDelegation: null,
        proofHash: null,
        // A persona's wire is stewardship-SHAPED (agent → custodian read), because that is the only
        // credential a second person agent of yours ever mints for you — so 'self' lands in the same slot.
        ...((entry.relationship === 'steward' || entry.relationship === 'self') && wire ? { stewardshipDelegation: wire } : {}),
        ...(entry.relationship === 'member' && wire ? { memberAccessDelegation: wire } : {}),
        // spec 323 W1-tail — faithful tree shape from the vault (kind/parent), not a flattened default.
        kind: entry.kind ?? 'org',
        parent: entry.parent ?? person,
        relationship: entry.relationship,
        createdAt: Date.parse(entry.updatedAt) || Date.now(),
      }));
      idx.push(org);
    }
    if (Object.keys(doc?.orgs ?? {}).length > 0) {
      await env.AUTH_CODES.put(`related-idx:${person}`, JSON.stringify(idx));
    }
  }

  const orgs: Array<Record<string, unknown>> = [];
  // PERF (2026-10-02): the per-org KV reads ran SEQUENTIALLY (one round-trip each, ~93 for a busy account) and,
  // worse, an on-chain reverseResolve ran inside the loop and serialized — a handful of un-healed names made this
  // endpoint take 7–19s live. Prefetch every KV row at once, and move the on-chain name heal to a BOUNDED, parallel
  // pass after the loop (cap NAME_HEAL_PER_REQUEST) so a pathological account can no longer serialize the hot read.
  const rawById = new Map(await Promise.all(idx.map(async (o) => [o, await env.AUTH_CODES.get(`related:${person}:${o}`)] as const)));
  const NAME_HEAL_PER_REQUEST = 4;
  const toHeal: Array<{ org: string; agent: string; idx: number }> = [];
  for (const org of idx) {
    const raw = rawById.get(org);
    if (!raw) continue;
    const link = JSON.parse(raw) as {
      orgAgent: string; orgName: string; purpose: string; requestedBy: string;
      siteDelegation: unknown; proofHash: string | null; createdAt?: number;
      membershipDelegation?: unknown; stewardshipDelegation?: unknown; memberAccessDelegation?: unknown; operationalDelegation?: unknown;
      readGrantDelegation?: unknown;
    };
    if (clientId && link.requestedBy !== clientId) continue; // relying-app view is scoped
    const l = link as typeof link & { kind?: string; parent?: string; relationship?: string; status?: string; governor?: string };
    // Name self-heal: a link written while the chain read lagged stored the ADDRESS as orgName (the
    // member's dropdowns then show 0x…). The link is a PROJECTION — reconcile it from the naming
    // service on read (ADR-0013-safe: reconciling a projection from its source, not a fallback).
    // Name self-heal is DEFERRED out of the hot path (see NAME_HEAL_PER_REQUEST above): note which need it; the
    // address stands in until a bounded parallel pass (below) resolves a few and writes them back for next time.
    if (!link.orgName || link.orgName.toLowerCase() === link.orgAgent.toLowerCase()) {
      toHeal.push({ org, agent: link.orgAgent, idx: orgs.length });
    }
    orgs.push({
      orgAgent: link.orgAgent,
      orgName: link.orgName,
      purpose: link.purpose,
      requestedBy: link.requestedBy,
      createdAt: link.createdAt ?? null,
      delegation: link.siteDelegation,
      proofHash: link.proofHash,
      // spec 246 person↔org read delegations: membership = person→org (org reads its
      // member); stewardship = org→person (person reads/oversees the org).
      membershipDelegation: link.membershipDelegation ?? null,
      stewardshipDelegation: link.stewardshipDelegation ?? null,
      // The org → app-service-agent Operational Intent grant. Returned because the ceremony is the
      // only moment it is MINTED, and a credential that cannot be read back afterwards is one the
      // agent it was granted to can never present.
      operationalDelegation: link.operationalDelegation ?? null,
      // The org → app-workspace READ grant (whitelabel org_read_grant) — returned for the same
      // reason: the ceremony is the only moment it is minted, and a grant the workspace cannot
      // read back is one it can never present.
      readGrantDelegation: link.readGrantDelegation ?? null,
      // spec 321 W2 — member-access = org→member (the member reads the org's shareable info).
      memberAccessDelegation: link.memberAccessDelegation ?? null,
      // spec 275: the agent kind + its parent in the member's agent tree. Legacy org
      // links (no kind) default to a person-parented 'org' so the tree still renders.
      // Legacy links predate kind persistence — the purpose tag names what they are. Healed at
      // the read so every consumer (switcher, projections, relying apps) agrees at once. A stored
      // GENERIC 'org' with a specific field purpose is the same legacy artifact as a missing kind:
      // the link was minted before Home's kind union carried the purpose's kind, so the purpose
      // wins over the stale generic — never over a specific stored kind.
      kind:
        (l.kind && l.kind !== 'org' ? l.kind : undefined) ??
        (l.purpose === 'field-workspace' ? 'workspace' : l.purpose === 'field-team' ? 'team' : l.purpose === 'field-circle' ? 'circle' : l.purpose === 'field-church' ? 'church' : (l.kind ?? 'org')),
      parent: l.parent ?? person,
      // spec 318: 'member' = authority-only (channels + switcher visibility, NO custody). Legacy
      // records default to 'steward' — the pre-membership control semantics, preserved.
      relationship: l.relationship ?? 'steward',
      // The ORGANIZATION THAT GOVERNS a workspace (2026-10-02, `aporg:governedBy`), when the link was written with
      // one: a governed workspace hangs under it (`parent`) and its membership lives there. Omitted for a legacy
      // workspace and for every organization; absent means "the agent itself", as the runtime reads it.
      ...(l.governor ? { governor: l.governor } : {}),
      // spec 342 — the org's lifecycle status, PROJECTED from its `org.lifecycle` vault record (the
      // authority for it is the org's vault, not this KV). Omitted when never set: absent means
      // active, so a link that predates the feature reads as active without a migration.
      ...(l.status ? { status: l.status } : {}),
    });
  }
  // Bounded, PARALLEL name heal: at most NAME_HEAL_PER_REQUEST on-chain reverseResolves per request, concurrent, so a
  // busy account's hot read never serializes them. The rest heal on later loads as the projection converges.
  if (toHeal.length > 0) {
    const naming = new AgentNamingClient({ rpcUrl: (env.RPC_URL || DEFAULT_RPC_URL), chainId: CHAIN_ID, registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver });
    await Promise.all(toHeal.slice(0, NAME_HEAL_PER_REQUEST).map(async (h) => {
      const healed = await naming.reverseResolve(h.agent as Address).catch(() => null);
      if (!healed) return;
      const o = orgs[h.idx];
      if (o) o.orgName = healed;
      const raw = rawById.get(h.org);
      if (raw) { try { await env.AUTH_CODES.put(`related:${person}:${h.org}`, JSON.stringify({ ...JSON.parse(raw), orgName: healed })); } catch { /* best-effort */ } }
    }));
  }

  // ── PRIVATE / LOCAL NAME — an agent with no PUBLIC name the viewer still knows by a local name ─────────────
  // A member of an org that never claimed a public name has a link whose `orgName` is the raw address (the public
  // reverseResolve above found nothing). The org's own name lives in its vault — readable by a member over member
  // access, and captured once into a rebuildable `org-localname:<agent>` projection (at org-create and by the
  // backfill). Fill it in here and MARK it local (`nameIsLocal`) so the surface can show "<name> *": a private
  // name the viewer holds, never a public registration. Only rows still showing the raw address are touched, so a
  // public name (healed above) always wins. Cheap KV gets, no vault read in this hot path.
  {
    const unnamed = orgs.filter((o) => String(o.orgName ?? '').toLowerCase() === String(o.orgAgent).toLowerCase());
    if (unnamed.length > 0) {
      await Promise.all(unnamed.map(async (o) => {
        try {
          const raw = await env.AUTH_CODES.get(`org-localname:${String(o.orgAgent).toLowerCase()}`);
          if (!raw) return;
          const proj = JSON.parse(raw) as { name?: string; isLocal?: boolean };
          const name = String(proj.name ?? '').trim();
          if (!name || name.toLowerCase() === String(o.orgAgent).toLowerCase()) return;
          o.orgName = name;
          if (proj.isLocal !== false) o.nameIsLocal = true;
        } catch { /* a missing/malformed projection just leaves the address showing */ }
      }));
    }
  }
  // ── THE RECONCILE THIS FILE ALREADY PROMISED ──────────────────────────────────────────────────
  // The POST above writes new links through to the person's AUTHORITATIVE vault doc, and says links
  // minted without a person session "surface in the doc at the person's next reconcile-capable
  // ceremony". Nothing performed that ceremony, so the doc held only the links written since
  // write-through landed, while this KV projection held everything (25 links in the Home, 3 in the
  // record). Every consumer that correctly reads the RECORD — the Ask's private tier, standing, roster
  // reach — therefore read a near-empty tree and reported "no links" for a person with two dozen.
  //
  // This is that ceremony: the person's own home view, under their own session, mirrors anything the
  // projection has and the record lacks. Additive and idempotent — it writes entries, never removes
  // them, and the record stays the authority (ADR-0055). Not a read fallback (ADR-0013): the read
  // still has one answer; this is a WRITE that makes the record catch up with what the person already
  // authorized.
  if (!clientId && token && orgs.length) {
    try {
      const { readRelationshipsDoc, mergeRelationshipEntry } = await import('../lib/relationships-doc');
      const doc = await readRelationshipsDoc(env, person, token).catch(() => null);
      if (doc) {
        const have = new Set(Object.keys(doc.orgs ?? {}).map((k) => k.toLowerCase()));
        const missing = orgs.filter((o) => !have.has(String(o.orgAgent).toLowerCase()));
        // Bounded: a person with hundreds of links catches up over a few visits rather than turning one
        // page load into a hundred vault writes.
        for (const o of missing.slice(0, 30)) {
          const wire = o.stewardshipDelegation ?? o.membershipDelegation ?? null;
          await mergeRelationshipEntry(env, person, token, {
            org: String(o.orgAgent),
            relationship: o.relationship === 'self' ? 'self' : o.relationship === 'member' ? 'member' : 'steward',
            ...(o.orgName ? { orgName: String(o.orgName) } : {}),
            ...(o.kind ? { kind: String(o.kind) } : {}),
            ...(o.parent ? { parent: String(o.parent) } : {}),
            ...(wire ? { delegations: [wire] } : {}),
          }).catch(() => undefined); // one entry's failure must not cost the person their home view
        }
      }
    } catch { /* the view is the job here; the reconcile is opportunistic */ }
  }

  // ── Spec 424 §2.3 — THE GOVERNED WORKSPACE A MEMBER MAY ENTER ─────────────────────────────────
  // A member relates to the governing ORGANIZATION, never to the workspace agent (the hub doctrine,
  // `lib/workspace-governor.ts`): `org → { members, teams, workspace }`, `workspace → org`. So the workspace
  // never appears in her own links — yet she must be able to FIND it, and be handed the grant her field runtime
  // chains her org membership onto to read its content (§2.4 B). We synthesize it here as DISCOVERY ONLY
  // (ADR-0056 — resolution is not authority): for each org she is a member of, read the org's
  // `org-workspace:<org>` projection — the governed workspace + its workspace→org content grant, written at
  // workspace-create and by the 424 backfill. That projection is a REBUILDABLE serving-plane view of the org's
  // `workspace:<ws>` vault record + the workspace's `workspace.governor.governorRead` (ADR-0055); the grant it
  // carries is re-verified at the workspace vault by the field runtime, and nothing here authorizes a read.
  // Synthesized AFTER the reconcile above, so these resolution rows never enter the person's authoritative
  // relationships doc — a governed workspace is not one of her relationships, it is reached THROUGH one.
  try {
    // Every ORG-CLASS row the person holds is a candidate governor; its `org-workspace:<org>` projection (if any)
    // names the workspace it governs. The projection repairs BOTH views the governor relationship is otherwise
    // missing from: a STEWARD holds the workspace row but it is parented by the person, not the org, so it carries
    // no `governor` (the graph then draws it standalone); a MEMBER has no workspace row at all.
    const GOVERNOR_KINDS = new Set(['org', 'team', 'circle', 'church', 'household', 'organization']);
    const governorRows = orgs.filter((o) => GOVERNOR_KINDS.has(String(o.kind ?? 'org').toLowerCase()));
    if (governorRows.length > 0) {
      const byAgent = new Map(orgs.map((o) => [String(o.orgAgent).toLowerCase(), o]));
      const projections = await Promise.all(governorRows.map(async (o) => {
        const raw = await env.AUTH_CODES.get(`org-workspace:${String(o.orgAgent).toLowerCase()}`);
        return raw ? ({ governorRow: o, proj: JSON.parse(raw) as { workspace?: string; workspaceName?: string; governor?: string; grant?: unknown; createdAt?: number } }) : null;
      }));
      for (const hit of projections) {
        if (!hit) continue;
        const ws = String(hit.proj.workspace ?? '').toLowerCase();
        const gov = String(hit.proj.governor ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(ws) || !/^0x[0-9a-f]{40}$/.test(gov)) continue;
        const existing = byAgent.get(ws);
        if (existing) {
          // The person already holds the workspace row (a steward): STAMP the governor so every reader — the
          // trust graph especially — knows it is governed, not standalone. Relationship/kind are left as held.
          if (!existing.governor) existing.governor = gov;
          continue;
        }
        // No workspace row — synthesize one ONLY for a MEMBER of the governor (resolution; §2.3). A steward who
        // simply lacks the row is not given a member row.
        if (String(hit.governorRow.relationship ?? 'steward').toLowerCase() !== 'member') continue;
        const row = {
          orgAgent: ws,
          orgName: hit.proj.workspaceName ?? '',
          purpose: 'field-workspace',
          requestedBy: clientId ?? '',
          createdAt: hit.proj.createdAt ?? null,
          kind: 'workspace',
          // She belongs to the GOVERNOR and reads the workspace THROUGH it — never a relationship to the ws agent.
          relationship: 'member',
          governor: gov,
          parent: gov,
          // The workspace→org CONTENT grant (§2.1/§2.4 B). Her field runtime chains her org membership onto this
          // to read the workspace's content; it is re-verified at the workspace vault, authorizing nothing here.
          readGrantDelegation: hit.proj.grant ?? null,
          // This row is a workspace she READS THROUGH the governor — not one she stewards, nor one she "joined".
          via: 'governed',
        };
        orgs.push(row);
        byAgent.set(ws, row);
      }
    }
  } catch { /* discovery is best-effort; a missing projection just means no synthesized/stamped workspace row */ }
  return jsonCors({ orgs }, request);
};

// POST /connect/related-orgs  (spec 247) — register a person→org link the person
// already governs (e.g. demo-jp's operator orgs, created outside the Connect
// org-create ceremony). Authorized by CONTROL OF THE PERSON SA: the caller signs
// the fixed challenge `keccak256("related-orgs:write:<person>")` with a custodian
// of the person SA; we verify via ERC-1271. Writes the same KV the GET reads, so
// the link surfaces in /you's existing related-orgs query — no new data source.
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as {
    person?: string; orgAgent?: string; orgName?: string; purpose?: string;
    requestedBy?: string; sig?: string; siteDelegation?: unknown; proofHash?: string | null;
    // spec 271 (W0a) — the recoverable custody descriptor for the org SA (private; salt + custody kind,
    // NO owner identifier). Persisted so an authenticated owner can later reconstruct the org's custodian.
    custody?: unknown;
    // spec 275 — managed-agent metadata: kind ∈ {person-treasury,org,org-treasury} and the
    // PARENT this agent hangs under in the member's tree (person SA, or an org SA the person controls).
    kind?: string;
    parent?: string;
    // spec 246 — person↔agent read delegations (stewardship = agent→parent so the parent can
    // read/oversee the agent's vault). Persisted so OrgDetail can read a home-created org's data.
    stewardshipDelegation?: unknown;
    membershipDelegation?: unknown;
    // steward (custody) vs member (authority-only) vs self. Defaults steward for legacy creator links.
    // External seeds (e.g. tracker demo) MUST send relationship:'member' for non-custodians.
    //
    // 'self' is the PERSONA case and it is not a third flavour of stewardship: the agent is ANOTHER
    // NAME FOR THE SAME HUMAN (a trail name, a part in a play), so there is nobody on the other side
    // of the relationship to steward. It is written down rather than inferred from `kind:'person'`
    // because a person could legitimately steward a person agent that is NOT them — a dependent's, an
    // estate's — and a tree that cannot tell those apart cannot say which agent is the person reading it.
    relationship?: 'steward' | 'member' | 'self';
    /** The ORGANIZATION that governs this workspace (2026-10-02, `aporg:governedBy`) — written by workspace-create,
     *  by a governed join, and by the migration. A projection of the pair of vault records; never authority. */
    governor?: string;
    /** Org-context display name the member shares (shown on the steward's roster / delegated-idx). */
    displayName?: string;
    /**
     * spec 342 — the org's lifecycle status, PROJECTED here so a roster can be filtered without one
     * vault read per row. The RECORD is `org.lifecycle` in the org's own vault, written over the
     * stewardship delegation; this field is its cache and carries no authority of its own.
     *
     * Rejected rather than coerced when unrecognised: a projection that can hold an arbitrary string
     * is one that can hide an organization by typo.
     */
    status?: string;
    // AUDIT NEW-RAG-2 — the ERC-1271 write path binds the signature to a one-shot nonce + short expiry.
    nonce?: string;
    expiry?: number;
    /**
     * Retire this link. Mirrors `relationships.merge`'s own `remove: true` on the authoritative doc.
     *
     * The KV here is a PROJECTION of that doc, and until now it could only ever GAIN rows: the GET
     * synthesizes a link for anything in the doc that KV lacks, and nothing removed one. So a person
     * who deleted an org from the authoritative record still saw it in every app that reads this
     * endpoint, permanently, with no route to fix it.
     *
     * EXPLICIT rather than inferred. The obvious alternative — have the GET prune whatever is absent
     * from the doc — would delete legitimate links the moment the doc read returned partial or empty,
     * which it does whenever the person's interactions plane is not enabled. A removal should happen
     * because somebody asked for it, not because a read came back thin.
     */
    remove?: boolean;
    /**
     * Spec 424 §2.3 — write the org→governed-workspace serving-plane projection (`org-workspace:<orgAgent>`): the
     * governed workspace + its workspace→org CONTENT grant (§2.4 B). The GET synthesizes this into an enterable
     * row for every member of the governing org, so a member can FIND the workspace and be handed the grant her
     * field runtime chains her org membership onto. REBUILDABLE from the org's `workspace:<ws>` vault record + the
     * workspace's `workspace.governor.governorRead` (ADR-0055), so losing it is a rebuild, never a bereavement.
     * Bearer path only — the person session must control the governor this projection keys on.
     */
    governedWorkspace?: { workspace?: string; workspaceName?: string; grant?: unknown };
    /** The PRIVATE/LOCAL name of an agent that never claimed a public name (`org-localname:<orgAgent>`): a member
     *  who holds it then sees a name, not an address. Rebuildable from the owner's vault; bearer path, caller must
     *  steward the agent. `isLocal:false` marks that the agent IS publicly named (shown without the `*`). */
    orgLocalName?: { name?: string; isLocal?: boolean };
  } | null;
  const person = (body?.person ?? '').toLowerCase();
  const org = (body?.orgAgent ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(person) || !/^0x[0-9a-f]{40}$/.test(org)) {
    return jsonCors({ error: 'person, orgAgent (0x…40) required' }, request, 400);
  }

  // Two explicit, caller-SELECTED auth methods (not a fallback chain — ADR-0013):
  //   • Bearer home-session token  → the person manages their OWN agent tree (spec 275).
  //   • `sig` (ERC-1271 over the   → an external custodian (e.g. demo-jp operator) registers
  //     fixed per-person challenge)   a person→org link it already governs (spec 247).
  const auth = request.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const sig = (body?.sig ?? '') as Hex;

  if (bearer) {
    // Home-session path: the token's `sub` IS the authority; it must equal `person`.
    const iss = resolveOrigin(request, env);
    const homeAud = env.DEMO_SSO_AUD ?? 'demo-sso';
    const { jwks } = await getServer(env);
    const keys = await importJwks(jwks);
    const v = await verifyAgentSession(bearer, { keys, expectedAud: homeAud, expectedIss: ownIssuer(request, env) });
    if (!v.ok) return jsonCors({ error: `invalid session token: ${v.reason}` }, request, 401);
    const sessionPerson = (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase();
    if (!sessionPerson || sessionPerson !== person) {
      return jsonCors({ error: 'session does not control this person' }, request, 401);
    }
    // spec 275 MAM-D6: an org-treasury's PARENT must be an org the person already controls
    // (present in their tree) — never an arbitrary address. Person-parented kinds are implicitly fine.
    const parent = (body?.parent ?? person).toLowerCase();
    if (parent !== person) {
      const ownIdx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
      if (!ownIdx.includes(parent)) {
        return jsonCors({ error: 'parent is not an agent you control' }, request, 401);
      }
    }
    // Spec 424 §2.3 — the org→governed-workspace projection. The person stewards the governor (`org`) it keys on
    // (they just created the pair, or they run the backfill under their session); the workspace→org content grant
    // rides in and is re-verified at the workspace vault by the field runtime — this write authorizes nothing.
    const gw = body?.governedWorkspace;
    if (gw) {
      const ws = String(gw.workspace ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(ws)) return jsonCors({ error: 'governedWorkspace.workspace (0x…40) required' }, request, 400);
      // The caller must STEWARD the governor this projection keys on — not merely hold a home session. The grant it
      // carries is re-verified at the workspace vault downstream, so a bogus projection authorizes nothing; this
      // check keeps a stranger from surfacing a fake workspace row to the org's members (resolution hygiene).
      const stewardLinkRaw = await env.AUTH_CODES.get(`related:${person}:${org}`);
      const stewardLink = stewardLinkRaw ? (JSON.parse(stewardLinkRaw) as { relationship?: string }) : null;
      if (!stewardLink || (stewardLink.relationship ?? 'steward') === 'member') {
        return jsonCors({ error: 'you do not steward the organization that governs this workspace' }, request, 403);
      }
      await env.AUTH_CODES.put(`org-workspace:${org}`, JSON.stringify({
        workspace: ws, workspaceName: String(gw.workspaceName ?? ''), governor: org, grant: gw.grant ?? null, createdAt: Date.now(),
      }));
      return jsonCors({ ok: true, governedWorkspace: ws }, request);
    }
    // The org's PRIVATE/LOCAL name projection (`org-localname:<org>`) — the name the owner gave an agent that
    // never claimed a public name, so a member who holds it sees a name rather than an address. The caller must
    // steward the agent it names (same check as the governed-workspace write). `isLocal:false` records that the
    // agent DOES have a public name (so a surface shows it without the `*`); default true.
    const ln = body?.orgLocalName;
    if (ln) {
      const name = String(ln.name ?? '').trim();
      if (!name) return jsonCors({ error: 'orgLocalName.name required' }, request, 400);
      const stewardLinkRaw = await env.AUTH_CODES.get(`related:${person}:${org}`);
      const stewardLink = stewardLinkRaw ? (JSON.parse(stewardLinkRaw) as { relationship?: string }) : null;
      if (!stewardLink || (stewardLink.relationship ?? 'steward') === 'member') {
        return jsonCors({ error: 'you do not steward this agent' }, request, 403);
      }
      await env.AUTH_CODES.put(`org-localname:${org}`, JSON.stringify({ name, isLocal: ln.isLocal !== false, at: Date.now() }));
      return jsonCors({ ok: true, orgLocalName: name }, request);
    }
  } else {
    // ERC-1271 control-of-person proof (spec-247 external-custodian path, e.g. a demo-jp operator org).
    // AUDIT NEW-RAG-2 — the signed challenge is BOUND to (person, org, content hash, one-shot nonce, expiry):
    // a captured signature is good for ONE write, of exactly that content, within its short window. The
    // server ALWAYS recomputes contentHash + the challenge from the persisted fields — a client digest is
    // never trusted — and burns the nonce so it can't be replayed.
    if (!sig.startsWith('0x')) return jsonCors({ error: 'sig or Bearer session required' }, request, 400);
    const nonce = (body?.nonce ?? '') as Hex;
    const expiry = Number(body?.expiry ?? 0);
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce) || !Number.isFinite(expiry) || expiry <= 0) {
      return jsonCors({ error: 'nonce (bytes32) + expiry (unix seconds) required for the signed write' }, request, 400);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiry < nowSec) return jsonCors({ error: 'write authorization expired' }, request, 401);
    if (expiry > nowSec + 3600) return jsonCors({ error: 'expiry too far in the future (max 1h)' }, request, 400);

    // One-shot nonce: reject a replay of an already-used (person, nonce). TTL just past max expiry.
    const nonceKey = `rag-nonce:${person}:${nonce.toLowerCase()}`;
    if (await env.AUTH_CODES.get(nonceKey)) return jsonCors({ error: 'write nonce already used (replay)' }, request, 401);

    // Recompute the bound challenge SERVER-SIDE from the persisted fields (never trust a client digest).
    const contentHash = relatedAgentWriteContentHash({
      orgAgent: org as Address,
      orgName: (body?.orgName ?? '') as string,
      purpose: (body?.purpose ?? '') as string,
      requestedBy: (body?.requestedBy ?? '') as string,
    });
    const challenge = hashRelatedAgentWriteChallenge({ person: person as Address, orgAgent: org as Address, contentHash, nonce, expiry });

    const client = createPublicClient({ transport: http(env.RPC_URL || DEFAULT_RPC_URL) });
    let valid = false;
    try {
      const r = (await client.readContract({
        address: person as Hex,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [challenge, sig],
      })) as string;
      valid = r === ERC1271_MAGIC;
    } catch {
      valid = false;
    }
    if (!valid) return jsonCors({ error: 'not authorized for person (ERC-1271 check failed)' }, request, 401);
    // Burn the nonce only AFTER a valid signature (so a bad-sig probe can't consume a victim's nonce).
    await env.AUTH_CODES.put(nonceKey, '1', { expirationTtl: 3700 });
  }

  // AUDIT NEW-RAG-1 — the recoverable custody descriptor is client-supplied; VALIDATE it server-side
  // (RC-INV-3: re-validates + rebuilds field-by-field, so a smuggled owner id `iss`/`sub` can't be
  // persisted at rest). Fail closed on bad input rather than storing raw bytes.
  let custodyValidated: unknown = undefined;
  if (body?.custody !== undefined && body?.custody !== null) {
    try {
      custodyValidated = buildCustodyDescriptor(body.custody as CustodyDescriptor);
    } catch (e) {
      return jsonCors({ error: 'invalid custody descriptor', detail: e instanceof Error ? e.message : String(e) }, request, 400);
    }
  }

  // ── RETIRE THE LINK ───────────────────────────────────────────────────────────────────────────
  // Runs after the same authorization the upsert requires: control of the person SA, proven by a
  // home-session bearer whose `sub` is this person or an ERC-1271 signature over the bound challenge.
  // Deleting a link you control is not a lesser act than creating one, so it is not a lesser gate.
  //
  // Idempotent: removing an absent link reports ok with `removed: false`, because a caller retrying
  // after a timeout should not be told it failed.
  if (body?.remove === true) {
    const had = await env.AUTH_CODES.get(`related:${person}:${org}`);
    await env.AUTH_CODES.delete(`related:${person}:${org}`);
    const idxNow = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
    const pruned = idxNow.filter((a) => a.toLowerCase() !== org);
    if (pruned.length !== idxNow.length) {
      await env.AUTH_CODES.put(`related-idx:${person}`, JSON.stringify(pruned));
    }
    // The AUTHORITATIVE doc is not touched here. It is the source this KV projects, it has its own
    // removal (`relationships.merge` + `remove: true`), and quietly writing it from the projection
    // side would invert which one is in charge. A caller retiring a link should do both, in that
    // order; if it does not, the next GET re-synthesizes this row from the doc — which is the
    // projection behaving correctly, not the removal failing.
    return jsonCors({ ok: true, removed: Boolean(had), orgAgent: org }, request, 200);
  }

  // MERGE with any existing record so a partial re-save (e.g. spec-275 name-later, which sends
  // only orgName) NEVER clobbers fields it doesn't carry — delegations, proofHash, custody persist.
  const existing = JSON.parse((await env.AUTH_CODES.get(`related:${person}:${org}`)) ?? '{}') as Record<string, unknown>;
  const pick = <T,>(next: T | undefined, prev: unknown, dflt: T): T => (next !== undefined ? next : (prev as T) ?? dflt);
  // A caller that NAMES a relationship decides it; one that names nothing keeps what is stored; a
  // link that has never carried one is a legacy creator link and reads as steward. 'member' keeps its
  // old stickiness (an authority-only seed must not be silently promoted to custody by a later
  // partial save that omits the field), and 'self' is likewise sticky: a persona does not stop being
  // the same human because some later write forgot to say so.
  const REL = ['steward', 'member', 'self'] as const;
  type Rel = (typeof REL)[number];
  const asked = REL.includes(body?.relationship as Rel) ? (body?.relationship as Rel) : undefined;
  const stored = REL.includes(existing.relationship as Rel) ? (existing.relationship as Rel) : undefined;
  const relationship: Rel =
    asked === 'member' || stored === 'member' ? 'member'
    : asked === 'self' || stored === 'self' ? 'self'
    : (asked ?? stored ?? 'steward');
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '';
  // spec 342 — validate the projected status against the closed codelist; absent leaves the
  // existing value alone (a partial re-save must not silently reactivate a retired org).
  if (body?.status !== undefined && !['active', 'inactive', 'deleted'].includes(String(body.status))) {
    return jsonCors({ error: 'status must be one of active | inactive | deleted' }, request, 400);
  }
  const link = {
    ...existing,
    orgAgent: org,
    orgName: pick(body?.orgName, existing.orgName, ''),
    purpose: pick(body?.purpose, existing.purpose, ''),
    requestedBy: pick(body?.requestedBy, existing.requestedBy, ''),
    siteDelegation: pick(body?.siteDelegation, existing.siteDelegation, null),
    // spec 246 — persist the read delegations (previously dropped on this path).
    stewardshipDelegation: pick(body?.stewardshipDelegation, existing.stewardshipDelegation, null),
    membershipDelegation: pick(body?.membershipDelegation, existing.membershipDelegation, null),
    proofHash: pick(body?.proofHash, existing.proofHash, null),
    // spec 271 (W0a) — persist the VALIDATED recoverable custody descriptor (NEW-RAG-1). Stored in
    // the same person-scoped KV the owner controls; read back by recoverCustodian (W0b).
    custody: custodyValidated !== undefined ? custodyValidated : (existing.custody ?? null),
    // spec 275 — agent kind + parent (defaults keep legacy org links person-parented).
    kind: pick(body?.kind, existing.kind, 'org'),
    parent: pick(body?.parent, existing.parent, person).toLowerCase(),
    ...(/^0x[0-9a-fA-F]{40}$/.test(String(body?.governor ?? '')) ? { governor: String(body!.governor).toLowerCase() } : {}),
    relationship,
    ...(displayName ? { displayName } : {}),
    // spec 342 — set only when the caller decided something; otherwise whatever `...existing` held
    // stands, and a link that never carried a status keeps not carrying one (absent = active).
    ...(body?.status !== undefined ? { status: String(body.status) } : {}),
    createdAt: (existing.createdAt as number) ?? Date.now(),
  };
  // Index the WHOLE tree under the person (root) so the home renders org-treasuries too (MAM-D7).
  await env.AUTH_CODES.put(`related:${person}:${org}`, JSON.stringify(link));
  const idx = JSON.parse((await env.AUTH_CODES.get(`related-idx:${person}`)) ?? '[]') as string[];
  if (!idx.includes(org)) {
    idx.push(org);
    await env.AUTH_CODES.put(`related-idx:${person}`, JSON.stringify(idx));
  }
  // Member seeds (external custodian path): also project onto the org's inbound roster so the
  // steward's Members panel / org-directory can find them without a naming-service claim.
  // NOT FOR A GOVERNED WORKSPACE (2026-10-02): a workspace agent has no roster — its members are the governing
  // organization's, projected onto `delegated-idx:<governor>` by the join's own membership write. The wire on
  // this link is the member's READ of the workspace's records and stays on the link; it is not a roster row.
  if (relationship === 'member' && link.membershipDelegation && !(link as { governor?: string }).governor) {
    const dKey = `delegated-idx:${org}`;
    const dIdx = JSON.parse((await env.AUTH_CODES.get(dKey)) ?? '[]') as Array<{ orgAgent: string; orgName: string; displayName?: string; delegation: unknown }>;
    if (!dIdx.some((x) => x.orgAgent.toLowerCase() === person)) {
      dIdx.push({
        orgAgent: person,
        orgName: displayName || String(link.orgName || ''),
        ...(displayName ? { displayName } : {}),
        delegation: link.membershipDelegation,
      });
      await env.AUTH_CODES.put(dKey, JSON.stringify(dIdx));
    } else if (displayName) {
      const row = dIdx.find((x) => x.orgAgent.toLowerCase() === person);
      if (row) { row.displayName = displayName; await env.AUTH_CODES.put(dKey, JSON.stringify(dIdx)); }
    }
  }
  // spec 323 W1 — mirror into the person's AUTHORITATIVE vault doc when this write rides their own
  // home session (the DO op is self-gated; the external-custodian sig path has no person session,
  // so its links surface in the doc at the person’s next home view — see the GET reconcile above).
  if (bearer) {
    const { mergeRelationshipEntry } = await import('../lib/relationships-doc');
    await mergeRelationshipEntry(env, person, bearer, {
      org,
      relationship,
      ...(link.orgName ? { orgName: String(link.orgName) } : {}),
      ...(link.kind ? { kind: String(link.kind) } : {}),
      ...(link.parent ? { parent: String(link.parent) } : {}),
      ...(link.stewardshipDelegation ? { delegations: [link.stewardshipDelegation] } : link.membershipDelegation ? { delegations: [link.membershipDelegation] } : {}),
    });
  }
  return jsonCors({ ok: true }, request);
};
