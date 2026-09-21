// /connect/library — a person's or organization's Content Artifact LIBRARY (spec 335).
//
// Leverages @agenticprimitives/content-storage: each library entry is a Content Artifact — a SKILL.md,
// a .ttl (which may live in GraphDB), a .md, a JSON-LD record (which may live in a vault), or an image —
// and access is managed PER ARTIFACT by granting other agents (person/org/service) entitlements to it,
// uniform across sources (content-storage §5.1/§7.1). The library index is authoritative in the
// principal's vault (person: the `content.catalog` record via A2A→MCP; org: org-vault); KV is a cache.
// Person scope = the session subject; org scope = steward-gated, DO-mediated (spec 315).
import { importJwks, verifyAgentSession } from '@agenticprimitives/connect';
// Mirrors @agenticprimitives/content-storage {ArtifactSource, ArtifactAction, AgentKind} (spec 335
// §5.1/§7.1) — inlined here until the content-storage workspace dep is installed/built for this
// Vercel app; the model (multi-source artifacts + per-artifact access grants) is identical.
type ArtifactSource = 'blob' | 'graphdb' | 'vault' | 'external';
type ArtifactAction = 'read' | 'write' | 'share' | 'export' | 'delete';
type AgentKind = 'person' | 'org' | 'service';
import type { Address, Hex } from '@agenticprimitives/types';
import { signCredential, canonicalHash } from '@agenticprimitives/verifiable-credentials';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
// Curated white-label entries AND member-registered ones (server/_lib/oidc-registry.ts).
import { resolveClient } from '../_lib/oidc-registry';
import { stewardWireFor, scopedWireFor, callInteractions } from './channels';
import { appendControlEvent } from './control-events';
import { demoPersonaFor, signDigestAsDemoPersona } from '../_lib/demo-custody';
import { CHAIN_ID } from '../../src/lib/chain';
import { issueLibraryAccessDelegation, toWire, type DelegationWire } from '../../src/lib/delegation';
import { MCP_SERVER_ID } from '../../src/lib/inbox-delivery';

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

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const iss = ownIssuer(request, env);
  // 1) the Home's own portal session (aud = demo-sso).
  let v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: iss });
  // 2) fall back to a REGISTERED relying-app id_token (e.g. skills-app), so an app can drive the
  //    person's LIBRARY on their behalf — same person, same vault, same per-artifact grants
  //    downstream. This mirrors /connect/channels exactly; the library route was written without it,
  //    which is why a relying app could manage a person's channels but not their own library.
  //    Only auds of registered clients are accepted; everything else is refused, so this widens WHO
  //    MAY ASK and not WHAT MAY BE ASKED — scope, ownership and every gate below are unchanged.
  if (!v.ok) {
    const aud = unverifiedAud(token);
    if (aud && (await resolveClient(env, aud))) {
      v = await verifyAgentSession(token, { keys, expectedAud: aud, expectedIss: iss });
    }
  }
  if (!v.ok) return null;
  return (v.session.sub.match(/0x[0-9a-fA-F]{40}$/)?.[0] ?? '').toLowerCase() || null;
}

/** One access grant on an artifact — the "give agent X access" record (content-storage §7.1). */
interface ArtifactGrant {
  grantee: { address: string; kind: AgentKind; label?: string };
  actions: ArtifactAction[];
  grantedAt: number;
  validUntil?: number;
  revoked?: boolean;
  /** The entitlement resource this grant authorizes: `artifact:<id>` for a document, or
   *  `container:<path>` for a FOLDER grant that cascades to the whole subtree (content-storage §7.2). */
  resource?: string;
  /** Set on an effective (read-side) grant that a document inherits from an ancestor folder — the
   *  folder's name. Absent on grants held directly on the entry. */
  inheritedFrom?: string;
  /** Reference to the durable entitlement record (an AgenticEntitlementCredentialV1 downstream). */
  entitlementId?: string;
  /** True when a signed AgenticEntitlementCredentialV1 was minted (owner ERC-1271 proof). */
  signed?: boolean;
  /** The paired scoped, revocable cross-principal delegation (owner → grantee, ADR-0019) — present
   *  when the owner is custodied and could server-sign it. The grantee is a delegate, never a custodian. */
  delegation?: DelegationWire;
}

/** Mint a signed AgenticEntitlementCredentialV1 for a grant — the owner SA is the issuer (ERC-1271).
 *  Server-side signing works when the owner is a custodied demo persona; a real user's credential is
 *  signed in a client ceremony (returned unsigned here). */
async function mintEntitlementCredential(env: FnContext['env'], owner: string, input: { entitlementId: string; resource: string; grantee: string; actions: ArtifactAction[]; validUntil?: number }): Promise<{ credential: unknown; signed: boolean }> {
  const unsigned = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'AgenticEntitlementCredentialV1'],
    id: `urn:ap:entitlement:${input.entitlementId}`,
    issuer: owner,
    validFrom: new Date().toISOString(),
    ...(input.validUntil ? { validUntil: new Date(input.validUntil).toISOString() } : {}),
    credentialSubject: { id: input.grantee, principal: owner, audience: env.DEMO_SSO_AUD ?? 'demo-sso', resource: input.resource, actions: input.actions },
  };
  const persona = demoPersonaFor(env, owner);
  if (!persona) return { credential: unsigned, signed: false };
  try {
    const vc = await signCredential(unsigned as never, {
      issuerAddress: owner as Address,
      chainId: CHAIN_ID,
      verifyingContract: owner as Address,
      signDigest: (d: Hex) => signDigestAsDemoPersona(persona, d),
    });
    return { credential: vc, signed: true };
  } catch {
    return { credential: unsigned, signed: false };
  }
}

/** Mint the paired cross-principal DELEGATION for a grant (content-storage §7.2, ADR-0019): the owner's
 *  custody signs a value-0, read-only, revocable delegation scoped to the container subtree
 *  (`vault:library.<path>:*`) or the single document — so the grantee is a *delegate, never a custodian*.
 *  Only minted when the owner is a custodied demo persona (a real owner signs client-side). */
async function mintAccessDelegation(env: FnContext['env'], owner: string, grantee: string, scope: { folderPath?: string; artifactId?: string }, validUntil?: number): Promise<DelegationWire | undefined> {
  const persona = demoPersonaFor(env, owner);
  if (!persona) return undefined;
  const validitySeconds = validUntil ? Math.max(60, Math.floor((validUntil - Date.now()) / 1000)) : undefined;
  try {
    const d = await issueLibraryAccessDelegation(owner as Address, grantee as Address, MCP_SERVER_ID, scope, (dig: Hex) => signDigestAsDemoPersona(persona, dig), validitySeconds);
    return toWire(d);
  } catch {
    return undefined;
  }
}

/** A library entry — a Content Artifact reference + its access grants. `source` names where the bytes
 *  live (blob/graphdb/vault/external); only `blob` inlines `bytesB64` in this demo. */
interface LibraryArtifact {
  id: string;
  kind: 'skill' | 'ttl' | 'md' | 'json-ld' | 'image';
  name: string;
  source: ArtifactSource;
  /** Explorer folder path this entry lives in (e.g. `reports/2026`); '' = root. */
  folder: string;
  /** True for a folder entry (an explorer container), not a document. */
  isFolder?: boolean;
  /** retrievalPointer for non-blob sources (e.g. `graphdb:faith/ontology`, `vault:0x…/impact-profile`). */
  pointer?: string;
  /** A discussion board bound to this artifact (via its artifact ContextRef), when one exists. */
  discussionId?: string;
  contentType: string;
  /** Small demo bytes inlined base64 (the avatar/message-body precedent); large media → R2 later. */
  bytesB64?: string;
  size: number;
  createdAt: number;
  /** Monotonic version — the append-only axis. Bumps on every re-save; starts at 1. */
  version: number;
  /** SHA-256 of the stored bytes (`0x…`), for blob artifacts — the content commitment the Provenance
   *  tab verifies. Absent for non-blob sources (their commitment lives with the owning store). */
  contentCommitment?: string;
  grants: ArtifactGrant[];
  /** Published skill releases (Phase 5) — a signed, append-only, version-monotonic release chain. */
  releases?: SkillReleaseRecord[];
  /** Spec 412 — `apcnt:accessPolicy` (C-box `apcnt:Public | Private`): the owner's declaration that ANYONE may read
   *  this entry, served by the owner's agent on the public lane. Absent = private. On a FOLDER it cascades to
   *  everything under it (containment, like a folder grant); the nearest declared ancestor decides. Public ≠ shared
   *  (a grant) ≠ published (a release): three acts, three records. */
  accessPolicy?: 'public' | 'private';
}

/** A published skill release — mirrors @agenticprimitives/content-storage `SkillRelease` (spec 335 §6,
 *  ADR-0055 §5). The `releaseId` is a canonical digest over the content/authority core and is INDEPENDENT
 *  of where the bytes live; owner and (delegated) publisher are separate; the publisher signs `releaseId`. */
interface SkillReleaseRecord {
  /** Location-independent skill identity — a canonical digest of the skill's stable name (demo stand-in
   *  for skill:<ns>/<name>). */
  canonicalId: string;
  version: string;
  /** The bundle's file-tree digest (a demo containment digest over member commitments). */
  bundleRoot: string;
  owner: string;
  publisher: string;
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  releaseId: string;
  /** Publisher ERC-1271 signature over `releaseId` (present when the publisher is a custodied persona). */
  signature?: string;
  signed: boolean;
  publishedAt: number;
}

/** Mint a signed skill release (Phase 5). Mirrors content-storage `buildRelease`/`computeReleaseId`: the
 *  releaseId is `canonicalHash` over the content/authority CORE only — canonicalId (from the skill's
 *  stable name, NOT its location), version, bundleRoot, owner, publisher, lockDigest, risk — so the same
 *  release from any vault has the same id. The owner/publisher persona signs the releaseId (ERC-1271). */
async function mintRelease(env: FnContext['env'], owner: string, art: LibraryArtifact, list: LibraryArtifact[]): Promise<SkillReleaseRecord> {
  // A page's release id is its own kind's — a page named like a skill is not that skill's release.
  const canonicalId = canonicalHash(art.kind === 'skill' || art.isFolder ? { skill: art.name } : { page: art.name, kind: art.kind });
  const bundleRoot = art.isFolder
    ? canonicalHash(list.filter((x) => x.folder === folderFullPath(art) && x.contentCommitment).map((x) => x.contentCommitment!).sort())
    : canonicalHash({ root: art.contentCommitment ?? `blob:${art.id}` });
  const version = `${(art.releases?.length ?? 0) + 1}.0.0`;
  const risk = { riskTier: 'low' as const, requestedCapabilities: ['read'] };
  const lockDigest = canonicalHash([] as unknown[]);
  const releaseId = canonicalHash({ canonicalId, version, bundleRoot, owner, publisher: owner, lockDigest, risk });
  const persona = demoPersonaFor(env, owner);
  let signature: string | undefined;
  let signed = false;
  if (persona) {
    try { signature = await signDigestAsDemoPersona(persona, releaseId as Hex); signed = true; } catch { /* unsigned in demo */ }
  }
  return { canonicalId, version, bundleRoot, owner, publisher: owner, riskTier: 'low', releaseId, signature, signed, publishedAt: Date.now() };
}

/** One INBOUND grant — the read-side index that powers "Shared with me": when owner A grants agent B,
 *  a pointer is written to B's inbound index so B discovers the artifact across vaults (federated lens).
 *  Keyed in KV by the grantee address; the authoritative grant still lives on the owner's artifact. */
interface InboundGrant {
  ownerScope: string;
  ownerKind: AgentKind;
  artifactId: string;
  artifactName: string;
  kind: LibraryArtifact['kind'];
  source: ArtifactSource;
  isFolder?: boolean;
  actions: ArtifactAction[];
  entitlementId: string;
  resource: string;
  grantedAt: number;
  revoked?: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const KINDS = new Set(['skill', 'ttl', 'md', 'json-ld', 'image']);
/** What a release can be minted for (398 §6.2): a skill, or a page. */
const PUBLISHABLE = new Set(['skill', 'md', 'json-ld']);
const SOURCES = new Set<ArtifactSource>(['blob', 'graphdb', 'vault', 'external']);
const ACCESS_POLICIES = new Set(['public', 'private']);
const ACTIONS = new Set<ArtifactAction>(['read', 'write', 'share', 'export', 'delete']);
const AGENT_KINDS = new Set<AgentKind>(['person', 'org', 'service']);

/** Resolve the acting scope: a person (session subject) or an org (steward-gated). Returns the read/
 *  write seam over the right vault + the KV cache key, or an error Response. */
interface LibraryScope {
  ok: true;
  owner: string;
  ownerKind: AgentKind;
  /** Person scope only — where the catalog was READ from: her vault, or this Home's KV cache because the vault answered
   *  nothing (never enabled, or written only by an app whose token cannot write it). Said on the GET as `source`. */
  source?: () => 'vault' | 'cache' | undefined;
  /** Person scope only — whether the LAST catalog write reached the vault (`true`), or stopped at this Home's KV
   *  cache (`false`). A relying app's token may read records and never write them (`read_grant_read_only`), so
   *  a library driven by an app lands here and nowhere the person's agent reads — said on the response as
   *  `vault: 'landed' | 'cache-only'` rather than hidden (398 §6.3). `undefined` for an org scope. */
  landed?: () => boolean | undefined;
  /** The catalog (index) list — `content.catalog`. */
  read: () => Promise<LibraryArtifact[]>;
  write: (list: LibraryArtifact[]) => Promise<void>;
  /** Per-record vault ops (ADR-0055): each artifact's content is its own addressable `content.artifact.<id>`
   *  record, so `ap-vault://<sa>/artifacts/<id>` (the `content.access.request` skill) can serve it. */
  putRecord: (recordType: string, data: unknown) => Promise<void>;
  delRecord: (recordType: string) => Promise<void>;
}
/**
 * A write that the ORG's own plane refused.
 *
 * Distinct from a thrown Error so the route can answer with the upstream status and resource rather
 * than turning every cause into a 500. A 503 from the org means "storage/plane unavailable"; a 403
 * means "this wire does not authorize it" — collapsing both loses the only information a caller can
 * act on.
 */
class LibraryWriteError extends Error {
  constructor(
    message: string,
    readonly resource: string,
    readonly upstreamStatus: number,
  ) {
    super(message);
    this.name = 'LibraryWriteError';
  }
}

async function scopeFor(request: Request, env: FnContext['env'], person: string, org?: string): Promise<LibraryScope | { ok: false; res: Response }> {
  const bearer = (request.headers.get('authorization') ?? '').slice(7);
  if (org) {
    const orgSA = org.toLowerCase();
    // Authorization to act FOR the org is a stewardship wire, re-verified downstream by the org DO.
    const wire = await stewardWireFor(env, person, orgSA, bearer);
    /*
      A SCOPED GRANT IS ALSO A WAY IN — for READS.

      Stewardship used to be the only proof this function would look for, so an organization's own
      members saw nothing of its records: every screen answered 403 and the app could only offer
      "view only" by making somebody a steward, which is read AND write AND act.

      A scoped data wire carries a vault-record-scope caveat naming exactly which resources and ops it
      covers. The DO evaluates that caveat per resource (`hasScopedAccess`), so presenting one here
      grants nothing by itself — it lets the record layer decide, which is the only place that can.

      WRITES STILL REFUSE, and not by accident: the scope returned below has no write path at all.
      That asymmetry is where "member views, steward acts" is actually enforced, and it is deliberate
      that it lives here rather than in a flag a caller could be wrong about.
    */
    const scopedAccess = wire ? null : await scopedWireFor(env, person, orgSA);
    if (!wire && !scopedAccess) {
      return { ok: false, res: jsonCors({ error: 'not a steward of this organization' }, request, 403) };
    }
    // Storage gate: orgVault is null unless the org enabled storage (a delivery grant exists). We reuse it
    // only as the gate; content itself rides the DO's `content.*` op (steward-bridged, ADR-0055).
    const { orgVault } = await import('../lib/org-vault');
    if (!(await orgVault(env, orgSA))) return { ok: false, res: jsonCors({ error: 'organization storage not enabled' }, request, 503) };
    // spec 341 §5.4 — the WIRE fetched three lines up is now what authorizes these ops, instead of the
    // shared secret. It was already required, already verified downstream, and then not used: the call
    // went out under `A2A_CUSTODY_BRIDGE_SECRET`, so what actually decided was *the caller is our Home*
    // rather than *this person may act for this organization*. Two different facts; only one of them is
    // about authority (ADR-0041).
    //
    // This remains a private RPC shape — not `message/send`, not a Card-declared skill — which is the
    // OTHER half of the violation and a separate wave. Fixing who-decided without fixing the shape is
    // real progress, and the gate's `total` ceiling exists so it can be made.
    const { callInteractions } = await import('./channels');
    const stewardArgs = wire ? { session: bearer, stewardship: wire } : { session: bearer, scopedAccess };
    const orgOp = async <T>(op: string, payload: Record<string, unknown>): Promise<{ ok: boolean; body: T & { error?: string }; status: number }> => {
      const r = await callInteractions(env, orgSA, op, { ...stewardArgs, ...payload });
      return { ok: r.status < 400 && r.body.ok !== false, body: r.body as T & { error?: string }, status: r.status };
    };
    // THROWS WITH THE ORG DO'S OWN REASON, and the message matters more than it looks.
    //
    // Every org-scoped WRITE previously surfaced as a bare 500 while the same scope's READ returned
    // 200 — because `read` degrades to `[]` on failure and this throws. A caller therefore saw
    // "reads work, writes 500", with nothing to distinguish "storage off" from "wire rejected" from
    // "content.put not allow-listed". Diagnosing it took isolating the call by hand with curl.
    //
    // Carrying `resource` and the upstream status makes the next one readable, and `LibraryWriteError`
    // lets the route answer with the real cause instead of collapsing to 500.
    const putRecord = async (recordType: string, data: unknown) => {
      const r = await orgOp('content.put', { resource: recordType, data });
      if (!r.ok) throw new LibraryWriteError(r.body.error ?? 'org content write failed', recordType, r.status);
    };
    /*
      A SCOPED CALLER MAY WRITE THE RECORDS THEIR GRANT NAMES — and only those.

      This refused every write from a scoped caller, which made a `read,write` grant unreachable: the
      wire said write, the layer in front of it offered no path, so a community progress steward could
      assert nothing. The refusal belonged one layer down all along — the DO evaluates the caveat per
      resource and answers 403 for a record the grant does not cover, which is the only place that can
      know.

      SO THE PATH IS OPEN AND THE DECISION IS DELEGATED. `putRecord` and `delRecord` present the wire;
      the DO decides. What stays refused HERE is nothing — a scoped catalog write reaches the DO too,
      where it is MERGED rather than applied, so a grant naming one community cannot drop another's
      records out of the index. Enforcing that here as a blanket refusal would have broken the very
      writes it was meant to make safe, because every save rewrites the catalog.
    */
    return {
      ok: true, owner: orgSA, ownerKind: 'org',
      read: async () => { const r = await orgOp<{ record?: unknown }>('content.get', { resource: 'content.catalog' }); return (r.ok ? (r.body.record as LibraryArtifact[] | null) : null) ?? []; },
      write: async (list) => { await putRecord('content.catalog', list); },
      putRecord,
      delRecord: async (recordType) => { await orgOp('content.put', { resource: recordType, data: null }); },
    };
  }
  // Person scope — authoritative in the person's VAULT via A2A→MCP (the InteractionsDO `record.*` seam,
  // now that `content.*` is allow-listed — ADR-0055 / PR #489). KV (`library:<person>[:<rec>]`) is a
  // rebuildable cache; the `content.catalog` index + per-artifact `content.artifact.<id>` records are
  // the DATA model.
  const { readCapabilityRecord, writeCapabilityRecord } = await import('../lib/capability-record');
  let landed: boolean | undefined;
  let source: 'vault' | 'cache' | undefined;
  return {
    ok: true, owner: person, ownerKind: 'person',
    landed: () => landed,
    source: () => source,
    read: async () => {
      const auth = await readCapabilityRecord<LibraryArtifact[]>(env, person, bearer, 'content.catalog');
      if (Array.isArray(auth)) { source = 'vault'; await env.AUTH_CODES.put(`library:${person}`, JSON.stringify(auth)); return auth; }
      source = 'cache';
      return JSON.parse((await env.AUTH_CODES.get(`library:${person}`)) ?? '[]') as LibraryArtifact[];
    },
    write: async (list) => {
      await env.AUTH_CODES.put(`library:${person}`, JSON.stringify(list));
      landed = await writeCapabilityRecord(env, person, bearer, 'content.catalog', list);
    },
    putRecord: async (recordType, data) => {
      await env.AUTH_CODES.put(`library:${person}:${recordType}`, JSON.stringify(data));
      // The vault's verdict is thrown so `sync` can name the record that stayed behind; `save` catches it (best-effort
      // there, the catalog stays authoritative) exactly as before.
      if (!(await writeCapabilityRecord(env, person, bearer, recordType, data))) throw new Error('the vault did not accept the record');
    },
    delRecord: async (recordType) => {
      await env.AUTH_CODES.delete(`library:${person}:${recordType}`);
      await writeCapabilityRecord(env, person, bearer, recordType, null);
    },
  };
}

export const onRequestGet = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const url = new URL(request.url);
  const org = url.searchParams.get('org') ?? undefined;
  const scope = await scopeFor(request, env, person, org);
  if (!scope.ok) return scope.res;
  // "Shared with me" — the federated inbound lens: artifacts OTHER vaults granted to this principal.
  if (url.searchParams.get('lens') === 'shared') {
    const inbound = JSON.parse((await env.AUTH_CODES.get(`library:inbound:${scope.owner}`)) ?? '[]') as InboundGrant[];
    const artifacts = inbound.filter((x) => !x.revoked).map(toSharedArtifact);
    return jsonCors({ owner: scope.owner, ownerKind: scope.ownerKind, lens: 'shared', artifacts }, request);
  }
  const artifacts = withEffectiveAccessPolicy(withEffectiveGrants(await scope.read()));
  // Pending access requests addressed to this owner (the "someone wants access" inbox).
  const requests = (await readRequests(env, scope.owner)).filter((r) => r.status === 'pending');
  // Spec 412 — `source` says whether this list is her VAULT's (what her agent serves) or this Home's cache (what an app
  // wrote under a token that cannot write her vault); the Library offers `sync` in the second case.
  const source = scope.source?.();
  return jsonCors({ owner: scope.owner, ownerKind: scope.ownerKind, artifacts, requests, ...(source ? { source } : {}) }, request);
};

// POST — one of: save (upsert artifact), delete (by id), grant (give an agent access to an artifact),
// revoke (a grant). The index is small; each is an atomic read-modify-write.
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as {
    action?: string; org?: string; artifact?: Partial<LibraryArtifact>; artifacts?: Partial<LibraryArtifact>[]; id?: string;
    grant?: { granteeAddress?: string; granteeKind?: string; granteeLabel?: string; actions?: string[]; validUntil?: number };
    /** Spec 412 `visibility`: the policy to declare on `id`. */
    accessPolicy?: string;
    // cross-vault read / request-access (Phase 3): the OWNER whose vault holds the artifact.
    ownerScope?: string; ownerKind?: string; actions?: string[]; artifactName?: string;
  } | null;
  if (!body?.action) return jsonCors({ error: 'action required' }, request, 400);

  const scope = await scopeFor(request, env, person, body.org);
  if (!scope.ok) return scope.res;
  const list = await scope.read();

  switch (body.action) {
    case 'save': {
      const entry = await upsert(list, body.artifact);
      if (!entry) return jsonCors({ error: 'artifact.name required' }, request, 400);
      await scope.write(list.slice(0, 200));
      await writeArtifactRecord(scope, entry);
      return jsonCors({ ok: true, artifact: entry, ...vaultWord(scope) }, request);
    }
    case 'save-batch': {
      // Bulk upload (drag-and-drop of many files) — one read-modify-write, atomic.
      if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) return jsonCors({ error: 'artifacts[] required' }, request, 400);
      const saved = (await Promise.all(body.artifacts.slice(0, 200).map((a) => upsert(list, a)))).filter((e): e is LibraryArtifact => !!e);
      try {
        await scope.write(list.slice(0, 200));
        await Promise.all(saved.map((e) => writeArtifactRecord(scope, e)));
      } catch (e) {
        // Answer with the org plane's own verdict. Previously this escaped as a bare 500 and the
        // caller could not tell an unavailable plane from an unauthorized one.
        if (e instanceof LibraryWriteError) {
          return jsonCors(
            { error: e.message, resource: e.resource, scope: scope.ownerKind, owner: scope.owner, upstreamStatus: e.upstreamStatus },
            request,
            e.upstreamStatus === 403 ? 403 : 503,
          );
        }
        throw e;
      }
      return jsonCors({ ok: true, count: saved.length }, request);
    }
    case 'delete': {
      const target = list.find((x) => x.id === body.id);
      let next = list.filter((x) => x.id !== body.id);
      // Deleting a folder removes everything under it.
      if (target?.isFolder) {
        const full = target.folder ? `${target.folder}/${target.name}` : target.name;
        next = next.filter((x) => x.folder !== full && !x.folder.startsWith(`${full}/`));
      }
      const removed = list.filter((x) => !next.some((n) => n.id === x.id));
      await scope.write(next);
      // Delete each removed artifact's per-artifact content record (folders have none).
      await Promise.all(removed.filter((x) => !x.isFolder).map((x) => scope.delRecord(`content.artifact.${x.id}`).catch(() => undefined)));
      return jsonCors({ ok: true, count: next.length }, request);
    }
    case 'grant': {
      const art = list.find((x) => x.id === body.id);
      const g = body.grant;
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      if (!g?.granteeAddress || !/^0x[0-9a-fA-F]{40}$/.test(g.granteeAddress)) return jsonCors({ error: 'grant.granteeAddress (0x…) required' }, request, 400);
      const kind = AGENT_KINDS.has(g.granteeKind as AgentKind) ? (g.granteeKind as AgentKind) : 'person';
      const actions = (g.actions ?? ['read']).filter((x): x is ArtifactAction => ACTIONS.has(x as ArtifactAction));
      if (actions.length === 0) return jsonCors({ error: 'grant.actions must include a valid action' }, request, 400);
      // Mint the durable entitlement — resource keyed on the artifact identity, uniform across sources
      // (content-storage §7.1). The signed AgenticEntitlementCredentialV1 + cross-principal delegation
      // land in the entitlements/delegation layer; here we record the entitlement and emit a NATIVE
      // notification via the control-event feed — no connector, out of the box.
      //
      // CONTAINMENT (content-storage §7.2): granting on a FOLDER mints a container-scoped entitlement
      // (`container:<path>`) that cascades to everything under it — the ancestor-walk in GET turns that
      // one grant into effective access for every descendant document. A document grant stays leaf-scoped.
      const resource = art.isFolder ? containerResourceId(folderFullPath(art)) : `artifact:${art.id}`;
      const entitlementId = `ent-${Math.abs(hash(`${resource}${g.granteeAddress}${Date.now()}`)).toString(36)}`;
      const validUntil = typeof g.validUntil === 'number' ? g.validUntil : undefined;
      const granteeAddr = g.granteeAddress.toLowerCase();
      // Mint the SIGNED entitlement credential (owner SA = issuer, ERC-1271 proof).
      const { credential, signed } = await mintEntitlementCredential(env, person, { entitlementId, resource, grantee: granteeAddr, actions, validUntil });
      // Pair it with a scoped, revocable cross-principal DELEGATION (ADR-0019, content-storage §7.2):
      // read-only over the container subtree (`vault:library.<path>:*`) for a folder, or the single
      // document — so a cross-org grantee is a *delegate, never a custodian*, and folder scope cascades.
      const delegation = await mintAccessDelegation(env, person, granteeAddr, art.isFolder ? { folderPath: folderFullPath(art) } : { artifactId: art.id }, validUntil);
      art.grants = art.grants.filter((x) => x.grantee.address.toLowerCase() !== granteeAddr);
      art.grants.push({
        grantee: { address: granteeAddr, kind, label: g.granteeLabel?.slice(0, 80) },
        actions, grantedAt: Date.now(), validUntil,
        resource, entitlementId, signed, delegation,
      });
      await scope.write(list);
      // Federate: write an inbound pointer so the grantee discovers this under "Shared with me".
      await writeInbound(env, granteeAddr, {
        ownerScope: scope.owner, ownerKind: scope.ownerKind, artifactId: art.id, artifactName: art.name,
        kind: art.kind, source: art.source, isFolder: art.isFolder, actions, entitlementId, resource, grantedAt: Date.now(),
      }).catch(() => undefined);
      // If this grant answers a pending access request, mark it granted (closes the request loop).
      const reqs = await readRequests(env, scope.owner);
      const before = reqs.length;
      const kept = reqs.map((r) => (r.requester === granteeAddr && r.artifactId === art.id && r.status === 'pending' ? { ...r, status: 'granted' as const } : r));
      if (kept.some((r, i) => r.status !== reqs[i]?.status) || kept.length !== before) await writeRequests(env, scope.owner, kept).catch(() => undefined);
      await appendControlEvent(env, person as Address, 'grant-issued', [], (request.headers.get('authorization') ?? '').slice(7)).catch(() => undefined);
      return jsonCors({ ok: true, artifact: art, entitlementId, signed, credential, delegation }, request);
    }
    case 'revoke': {
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      const addr = body.grant?.granteeAddress?.toLowerCase();
      const resource = art.grants.find((x) => x.grantee.address === addr)?.resource;
      art.grants = art.grants.map((x) => (x.grantee.address === addr ? { ...x, revoked: true } : x));
      await scope.write(list);
      // Withdraw the federated inbound pointer for the grantee.
      if (addr) await revokeInbound(env, addr, scope.owner, resource).catch(() => undefined);
      await appendControlEvent(env, person as Address, 'grant-revoked', [], (request.headers.get('authorization') ?? '').slice(7)).catch(() => undefined);
      return jsonCors({ ok: true, artifact: art }, request);
    }
    case 'open': {
      // Cross-vault READ (Phase 3): the requester presents its authority; the OWNER's origin re-checks
      // the grant against its authoritative list (fail-closed) and releases an audience-bound copy.
      const ownerScope = typeof body.ownerScope === 'string' ? body.ownerScope : person;
      const ownerKind: AgentKind = body.ownerKind === 'org' ? 'org' : 'person';
      // spec 341 §5.6 — AN ORG OWNER RELEASES ONE ARTIFACT, OR NOTHING. This used to pull the org's
      // ENTIRE catalog over the shared secret and evaluate the sharing grants here: every artifact the
      // org held crossed the wire to answer a question about one, and the check that mattered ran after
      // the disclosure it was meant to prevent. Now the org's own agent evaluates its own grants and
      // the catalog never leaves.
      //
      // The PERSON branch is genuinely different, not an exemption: their catalog IS this Home's KV, so
      // there is no other holder to ask.
      let art: LibraryArtifact | undefined;
      if (ownerKind !== 'org') {
        // A PERSON owner's catalog is this Home's own KV — there is no separate holder to ask, and
        // nothing crosses a trust boundary that the shared-worker demo topology does not already
        // collapse. The grant check below is the owner's own, over the owner's own list.
        const ownerList = await readOwnerList(env, ownerScope, ownerKind);
        art = ownerList.find((x) => x.id === body.id);
        const holds = ownerScope === person || (art && activeEffectiveGrants(ownerList, art).some((g) => g.grantee.address.toLowerCase() === person.toLowerCase()));
        if (!holds) art = undefined;
      } else {
        const { callInteractions } = await import('./channels');
        const r = await callInteractions(env, ownerScope, 'content.shared', {
          session: (request.headers.get('authorization') ?? '').slice(7),
          artifactId: body.id,
        }).catch(() => null);
        art = (r && r.status < 400 ? (r.body.artifact as LibraryArtifact | null) : null) ?? undefined;
      }
      // Unknown and not-shared are ONE answer, deliberately. Separating them would let a reader
      // enumerate what an owner holds by asking for ids and reading the difference in the refusal.
      if (!art) return jsonCors({ error: 'access to this artifact was revoked or never granted' }, request, 403);
      // Read receipt = the READER's own use-receipt (evidence *I* accessed this), written to the READER's
      // OWN vault (`content.receipt.<id>`, tamper-evident) — vault-first (a principal writes only its own
      // vault; no cross-principal write), closing the "receipts belong in a vault" finding (ADR-0055).
      await scope.putRecord(`content.receipt.${crypto.randomUUID()}`, { kind: 'read', subject: art.id, servedBy: ownerScope, at: Date.now() }).catch(() => undefined);
      return jsonCors({ ok: true, servedBy: ownerScope, artifact: { id: art.id, name: art.name, kind: art.kind, source: art.source, contentType: art.contentType, bytesB64: art.bytesB64, pointer: art.pointer, version: art.version, contentCommitment: art.contentCommitment } }, request);
    }
    case 'request-access': {
      // The requester asks an owner for access to an artifact they don't yet hold — lands in the owner's
      // requests inbox (surfaced on the owner's GET); the owner approves by issuing a grant.
      const ownerScope = typeof body.ownerScope === 'string' ? body.ownerScope : undefined;
      if (!ownerScope || !body.id) return jsonCors({ error: 'ownerScope and id required' }, request, 400);
      const actions = (body.actions ?? ['read']).filter((x): x is ArtifactAction => ACTIONS.has(x as ArtifactAction));
      const requester = person.toLowerCase();
      const reqs = await readRequests(env, ownerScope);
      if (!reqs.some((r) => r.requester === requester && r.artifactId === body.id && r.status === 'pending')) {
        reqs.push({ requester, artifactId: body.id, artifactName: body.artifactName, actions: actions.length ? actions : ['read'], at: Date.now(), status: 'pending' });
        await writeRequests(env, ownerScope, reqs);
      }
      return jsonCors({ ok: true, status: 'requested' }, request);
    }
    case 'publish': {
      // Publish a signed RELEASE (Phase 5) — owner-gated, append-only, version-monotonic. A skill or a bundle folder,
      // and (spec 398 §6.2 — share · publish · replicate are three acts) a PAGE: an `md` or `json-ld` artifact, whose
      // release names its content commitment so a site that serves it can prove what it serves. Not an image, not a
      // ttl (an ontology is published through the corpus, never a Library release).
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      if (!PUBLISHABLE.has(art.kind) && !art.isFolder) return jsonCors({ error: 'only a skill, a page (md, json-ld) or a bundle folder can be published as a release' }, request, 400);
      if (!art.isFolder && !art.contentCommitment) return jsonCors({ error: 'a page with no content cannot be published — a release names what it serves' }, request, 400);
      const release = await mintRelease(env, person, art, list);
      art.releases = [...(art.releases ?? []), release];
      await scope.write(list);
      await appendControlEvent(env, person as Address, 'credential-issued', [], (request.headers.get('authorization') ?? '').slice(7)).catch(() => undefined);
      return jsonCors({ ok: true, artifact: art, release, ...vaultWord(scope) }, request);
    }
    case 'sync': {
      // Spec 412 — MOVE THIS HOME'S CACHE INTO HER VAULT, under her own session. A relying app's token reads records and
      // never writes them, so everything such an app saved (a work's manifest, a profile) lived only in this Home's KV,
      // where her agent — which reads her vault — never saw it. Under her session the writes land: the catalog and
      // every document's record. Idempotent; refused for an org scope (an org's plane refuses or accepts per write).
      if (scope.ownerKind !== 'person' || !scope.source) return jsonCors({ error: 'sync is the person\'s own act on their own vault' }, request, 400);
      const wrote: string[] = []; const failed: string[] = [];
      await scope.write(list);
      if (scope.landed?.() === false) return jsonCors({ error: 'the vault did not accept the catalog — is the interactions plane enabled for this agent?', vault: 'cache-only' }, request, 503);
      for (const a of list) {
        if (a.isFolder) continue;
        try { await writeArtifactRecordStrict(scope, a); wrote.push(a.id); } catch (e) { failed.push(`${a.id}: ${e instanceof Error ? e.message : 'failed'}`); }
      }
      return jsonCors({ ok: failed.length === 0, synced: wrote.length, failed, vault: 'landed' }, request);
    }
    case 'visibility': {
      // Spec 412 — the owner declares who may read: `public` (anyone, through the owner's agent's public lane) or
      // `private` (the default — grants and releases untouched). On a folder it cascades to everything under it; a
      // document or folder declared `private` inside a public folder stays private. Owner-gated like every write here.
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      if (!ACCESS_POLICIES.has(String(body.accessPolicy))) return jsonCors({ error: 'accessPolicy must be "public" or "private"' }, request, 400);
      art.accessPolicy = body.accessPolicy as 'public' | 'private';
      await scope.write(list);
      // The per-artifact record carries the declaration too, so a reader of the record alone sees it.
      await writeArtifactRecord(scope, art);
      await appendControlEvent(env, person as Address, art.accessPolicy === 'public' ? 'credential-issued' : 'grant-revoked', [], (request.headers.get('authorization') ?? '').slice(7)).catch(() => undefined);
      return jsonCors({ ok: true, artifact: art, effectiveAccessPolicy: effectiveAccessPolicyOf(list, art), ...vaultWord(scope) }, request);
    }
    case 'discuss': {
      // Bind a native discussion board to this artifact via its artifact ContextRef (spec 335 §7.1).
      // The same ContextRef{kind:'artifact', id:'artifact:<id>'} every messaging/discussion surface accepts.
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      const contextRef = { kind: 'artifact', id: `artifact:${art.id}`, label: art.name };
      let discussionId = art.discussionId;
      if (!discussionId && body.org) {
        // Org scope: create a native board carrying the artifact ContextRef (best-effort; DO-mediated).
        const r = await callInteractions(env, body.org, 'channels.create', { title: `Re: ${art.name}`, contextRefs: [contextRef] });
        discussionId = typeof r.body.channelId === 'string' ? r.body.channelId : typeof r.body.id === 'string' ? r.body.id : undefined;
      }
      if (!discussionId) discussionId = `disc:${contextRef.id}`; // person scope / fallback binding
      art.discussionId = discussionId;
      await scope.write(list);
      return jsonCors({ ok: true, discussionId, contextRef }, request);
    }
    default:
      return jsonCors({ error: `unknown action "${body.action}"` }, request, 400);
  }
};

/** The same record write, but THROWING when it does not land — `sync` must say which document stayed behind. */
async function writeArtifactRecordStrict(scope: LibraryScope, a: LibraryArtifact): Promise<void> {
  if (a.isFolder) return;
  await scope.putRecord(`content.artifact.${a.id}`, {
    id: a.id, kind: a.kind, name: a.name, source: a.source, contentType: a.contentType,
    bytesB64: a.bytesB64, pointer: a.pointer, commitment: a.contentCommitment, version: a.version,
    ...(a.accessPolicy ? { accessPolicy: a.accessPolicy } : {}),
  });
}

/** Persist an artifact's per-artifact content record — `content.artifact.<id>` (ADR-0055): the
 *  addressable, servable content view (bytes/pointer/type/commitment). Written on save so
 *  `ap-vault://<sa>/artifacts/<id>` (the `content.access.request` skill → `get_vault_record`) resolves
 *  to it. Folders (containers) have no content record. Best-effort — the catalog stays authoritative. */
async function writeArtifactRecord(scope: LibraryScope, a: LibraryArtifact): Promise<void> {
  if (a.isFolder) return;
  await scope.putRecord(`content.artifact.${a.id}`, {
    id: a.id, kind: a.kind, name: a.name, source: a.source, contentType: a.contentType,
    bytesB64: a.bytesB64, pointer: a.pointer, commitment: a.contentCommitment, version: a.version,
    ...(a.accessPolicy ? { accessPolicy: a.accessPolicy } : {}),
  }).catch(() => undefined);
}

/** SHA-256 of base64 bytes as `0x…` — the content commitment for a stored blob (the same hash the
 *  Provenance tab shows as "verified"; content-addressed integrity, computed at the origin). */
async function sha256Hex(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `0x${[...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Build + upsert one artifact into the list (mutating), preserving grants on update. Bumps the version
 *  and (for blobs) recomputes the content commitment. Returns the entry, or null when invalid (no name). */
async function upsert(list: LibraryArtifact[], a: Partial<LibraryArtifact> | undefined): Promise<LibraryArtifact | null> {
  if (!a || typeof a.name !== 'string' || !a.name.trim()) return null;
  const kind = KINDS.has(String(a.kind)) ? (a.kind as LibraryArtifact['kind']) : 'md';
  const source = SOURCES.has(a.source as ArtifactSource) ? (a.source as ArtifactSource) : 'blob';
  const id = a.id && ID_RE.test(a.id) ? a.id : `art-${Math.abs(hash(`${a.name}${Date.now()}${Math.random()}`)).toString(36)}`;
  const folder = typeof a.folder === 'string' ? a.folder.replace(/^\/+|\/+$/g, '').slice(0, 256) : '';
  const idx = list.findIndex((x) => x.id === id);
  const bytesB64 = source === 'blob' && typeof a.bytesB64 === 'string' ? a.bytesB64.slice(0, 2_000_000) : undefined;
  const entry: LibraryArtifact = {
    id, kind, name: a.name.trim().slice(0, 120), source, folder,
    isFolder: a.isFolder === true ? true : undefined,
    pointer: typeof a.pointer === 'string' ? a.pointer.slice(0, 512) : undefined,
    contentType: typeof a.contentType === 'string' ? a.contentType : defaultMime(kind),
    bytesB64,
    size: typeof a.size === 'number' ? a.size : (a.bytesB64?.length ?? 0),
    createdAt: Date.now(),
    // Append-only version axis: re-saving an existing id advances its version.
    version: idx >= 0 ? (list[idx]!.version ?? 1) + 1 : 1,
    contentCommitment: bytesB64 ? await sha256Hex(bytesB64) : undefined,
    grants: [],
    // Spec 412 — a declared policy on the save is kept; a re-save that says nothing keeps what the entry had.
    ...(ACCESS_POLICIES.has(String(a.accessPolicy)) ? { accessPolicy: a.accessPolicy as 'public' | 'private' } : idx >= 0 && list[idx]!.accessPolicy ? { accessPolicy: list[idx]!.accessPolicy } : {}),
  };
  if (idx >= 0) { entry.grants = list[idx]!.grants; entry.releases = list[idx]!.releases; list[idx] = entry; } else list.push(entry);
  return entry;
}

/** Write/refresh an inbound-grant pointer in the grantee's index (the "Shared with me" federated lens). */
async function writeInbound(env: FnContext['env'], grantee: string, entry: InboundGrant): Promise<void> {
  const key = `library:inbound:${grantee}`;
  const listInbound = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as InboundGrant[];
  const i = listInbound.findIndex((x) => x.ownerScope === entry.ownerScope && x.resource === entry.resource);
  if (i >= 0) listInbound[i] = entry; else listInbound.push(entry);
  await env.AUTH_CODES.put(key, JSON.stringify(listInbound.slice(0, 500)));
}

/** Mark a grantee's inbound pointer revoked when the owner revokes the grant. */
async function revokeInbound(env: FnContext['env'], grantee: string, ownerScope: string, resource?: string): Promise<void> {
  const key = `library:inbound:${grantee}`;
  const listInbound = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as InboundGrant[];
  let changed = false;
  for (const x of listInbound) if (x.ownerScope === ownerScope && (!resource || x.resource === resource) && !x.revoked) { x.revoked = true; changed = true; }
  if (changed) await env.AUTH_CODES.put(key, JSON.stringify(listInbound));
}

/**
 * Read the OWNER's authoritative library list — the origin acting as the owner's vault resource server
 * (Phase 3). Person: the KV-cached index; org: the org vault index.
 *
 * ⚠ THE LAST HMAC AUTHORITY GAP IN THIS ROUTE (spec 341 §5.4), and it is NOT a conversion candidate.
 * The other `content.*` ops here moved to the org's stewardship delegation because the caller IS a
 * steward. This one is the SHARED lens: B reading what A shared with them, so B has no stewardship over
 * A's org and no wire to present. Today the Home reads A's ENTIRE catalog under the shared secret and
 * then filters it by A's sharing grants in `activeEffectiveGrants` — so the authority decision happens
 * at the Home, AFTER an unauthorized read, and a bug in the filter is a disclosure rather than a denial.
 *
 * The fix is the one the original comment gestured at without naming the consequence: an A2A/MCP call
 * to A's vault carrying B'S OWN grant, so A's side decides what B may see and never returns the rest.
 * That is a sharing-grant → delegation change, not a transport swap, which is why it is left standing
 * and counted rather than quietly worked around.
 */
async function readOwnerList(env: FnContext['env'], ownerScope: string, _ownerKind: AgentKind): Promise<LibraryArtifact[]> {
  // OWN list only. The org branch is gone with the shared lens (spec 341 §5.6): reading another
  // owner's catalog to answer a question about one artifact was the disclosure this repo kept
  // rediscovering, and `content.shared` replaced it — the owner's agent evaluates its own grants and
  // releases one artifact or nothing. The only caller left asks for its OWN list, where the KV index is
  // the authoritative copy.
  return JSON.parse((await env.AUTH_CODES.get(`library:${ownerScope}`)) ?? '[]') as LibraryArtifact[];
}

/** All ACTIVE grants that authorize reading an artifact — its own grants plus those inherited from any
 *  ancestor folder (the containment cascade). The origin re-runs this over the owner's list at read time. */
function activeEffectiveGrants(list: LibraryArtifact[], art: LibraryArtifact): ArtifactGrant[] {
  const own = art.grants.filter((g) => !g.revoked);
  const folderGrants = new Map<string, ArtifactGrant[]>();
  for (const f of list) if (f.isFolder && f.grants.length) folderGrants.set(folderFullPath(f), f.grants.filter((g) => !g.revoked));
  const inherited: ArtifactGrant[] = [];
  for (const p of ancestorFolderPaths(art.folder)) { const fg = folderGrants.get(p); if (fg) inherited.push(...fg); }
  return [...own, ...inherited];
}

interface AccessRequest { requester: string; artifactId: string; artifactName?: string; actions: ArtifactAction[]; at: number; status: 'pending' | 'granted' }
// Access requests + the "Shared with me" inbound index are LEGITIMATELY non-vault (ADR-0055 exceptions),
// not KV-as-authority: requests are short-lived operational/transport state (the vault-correct form is an
// A2A `content.access.request` intent delivered to the owner's inbox, not a requester-write to the owner's
// vault); the inbound index is a REBUILDABLE projection of grants across vaults (derivable from owners'
// authoritative grant lists). Both are cross-principal writes, so they cannot become owner/grantee vault
// records without violating "a principal writes only its own vault". Read receipts, which ARE durable
// evidence, moved to the reader's own vault (see the `open` action).
/** Pending access requests addressed to an owner (the owner's inbox for "someone wants access"). */
async function readRequests(env: FnContext['env'], ownerScope: string): Promise<AccessRequest[]> {
  return JSON.parse((await env.AUTH_CODES.get(`library:requests:${ownerScope}`)) ?? '[]') as AccessRequest[];
}
async function writeRequests(env: FnContext['env'], ownerScope: string, reqs: AccessRequest[]): Promise<void> {
  await env.AUTH_CODES.put(`library:requests:${ownerScope}`, JSON.stringify(reqs.slice(-200)));
}

/** Project inbound grants into the artifact shape the explorer's "Shared with me" lens renders. */
function toSharedArtifact(g: InboundGrant): Record<string, unknown> {
  return {
    id: g.artifactId, name: g.artifactName, kind: g.kind, source: g.source, folder: '', isFolder: g.isFolder,
    contentType: '', size: 0, createdAt: g.grantedAt, version: 1, grants: [],
    accessMode: 'Read-through', sharedBy: g.ownerScope, sharedByKind: g.ownerKind, myActions: g.actions, entitlementId: g.entitlementId,
  };
}

function defaultMime(kind: LibraryArtifact['kind']): string {
  return kind === 'ttl' ? 'text/turtle' : kind === 'json-ld' ? 'application/ld+json' : kind === 'image' ? 'image/png' : 'text/markdown';
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// ── Containment hierarchy: folder grants cascade to the subtree ──
// The canonical primitive is @agenticprimitives/content-storage `containment` (containerResourceId /
// ancestorContainerResources / resolveWithInheritance + the Merkle `containmentRoot`). These few pure
// helpers inline the same ancestor-walk here (content-storage isn't linked into this Vercel app), so a
// grant on a folder reaches every document under it — the "grant a folder → everything in and under it
// is accessible" behavior, identical to the spatial country→state→…→point case.

/** A folder entry's full path, e.g. folder `reports` name `2026` → `reports/2026`. */
function folderFullPath(a: Pick<LibraryArtifact, 'folder' | 'name'>): string {
  return a.folder ? `${a.folder}/${a.name}` : a.name;
}
/** The container resource id for a path — access on it cascades to the whole subtree. */
function containerResourceId(path: string): string {
  return `container:${path.replace(/^\/+|\/+$/g, '')}`;
}
/** Inclusive ancestor folder paths of a document's folder: `a/b/c` → [`a`, `a/b`, `a/b/c`]. */
function ancestorFolderPaths(folder: string): string[] {
  const segs = folder.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/** Attach `effectiveGrants` to each artifact: its own grants PLUS grants inherited from any ancestor
 *  folder (marked `inheritedFrom`). This is the read-side ancestor-walk that realizes folder cascade. */
/** Where the last write landed, in one word on the response — `landed` (the person's vault, which her agent reads) or
 *  `cache-only` (this Home's KV: a relying app's token reads records and never writes them, so its saves stop here and
 *  the person's agent does not see them). Absent for an org scope, whose writes throw when refused. */
function vaultWord(scope: LibraryScope): { vault?: 'landed' | 'cache-only' } {
  const l = scope.landed?.();
  return l === undefined ? {} : { vault: l ? 'landed' : 'cache-only' };
}

/** Spec 412 §1.1 — the effective policy of an entry: its own, else the nearest declared ancestor folder's, else private. */
export function effectiveAccessPolicyOf(list: ReadonlyArray<Pick<LibraryArtifact, 'folder' | 'name' | 'isFolder' | 'accessPolicy'>>, a: Pick<LibraryArtifact, 'folder' | 'name' | 'isFolder' | 'accessPolicy'>): 'public' | 'private' {
  if (a.accessPolicy === 'public' || a.accessPolicy === 'private') return a.accessPolicy;
  const byPath = new Map<string, 'public' | 'private'>();
  for (const f of list) if (f.isFolder && (f.accessPolicy === 'public' || f.accessPolicy === 'private')) byPath.set(folderFullPath(f), f.accessPolicy);
  const parts = (a.folder ?? '').split('/').filter(Boolean);
  for (let i = parts.length; i > 0; i--) { const p = byPath.get(parts.slice(0, i).join('/')); if (p) return p; }
  return 'private';
}
function withEffectiveAccessPolicy<T extends LibraryArtifact>(list: T[]): (T & { effectiveAccessPolicy: 'public' | 'private' })[] {
  return list.map((a) => ({ ...a, effectiveAccessPolicy: effectiveAccessPolicyOf(list, a) }));
}

function withEffectiveGrants(list: LibraryArtifact[]): (LibraryArtifact & { effectiveGrants?: ArtifactGrant[] })[] {
  // Map each ancestor folder path → the folder entry's (cascading) grants.
  const folderGrants = new Map<string, { label: string; grants: ArtifactGrant[] }>();
  for (const f of list) {
    if (f.isFolder && f.grants.length) folderGrants.set(folderFullPath(f), { label: f.name, grants: f.grants });
  }
  return list.map((a) => {
    if (a.isFolder) return a;
    const inherited: ArtifactGrant[] = [];
    for (const path of ancestorFolderPaths(a.folder)) {
      const fg = folderGrants.get(path);
      if (fg) for (const g of fg.grants) if (!g.revoked) inherited.push({ ...g, inheritedFrom: fg.label });
    }
    return inherited.length ? { ...a, effectiveGrants: [...a.grants, ...inherited] } : a;
  });
}
