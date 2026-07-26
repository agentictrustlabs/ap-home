// /connect/library — a person's or organization's Content Artifact LIBRARY (spec 335).
//
// Leverages @agenticprimitives/content-storage: each library entry is a Content Artifact — a SKILL.md,
// a .ttl (which may live in GraphDB), a .md, a JSON-LD record (which may live in a vault), or an image —
// and access is managed PER ARTIFACT by granting other agents (person/org/service) entitlements to it,
// uniform across sources (content-storage §5.1/§7.1). The library index is authoritative in the
// principal's vault (`library.index`, the skills.data pattern, spec 323); KV is a rebuildable cache.
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
import { stewardWireFor, callInteractions } from './channels';
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

async function personFrom(request: Request, env: FnContext['env']): Promise<string | null> {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const { jwks } = await getServer(env);
  const keys = await importJwks(jwks);
  const v = await verifyAgentSession(token, { keys, expectedAud: env.DEMO_SSO_AUD ?? 'demo-sso', expectedIss: ownIssuer(request, env) });
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
  const canonicalId = canonicalHash({ skill: art.name });
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
const SOURCES = new Set<ArtifactSource>(['blob', 'graphdb', 'vault', 'external']);
const ACTIONS = new Set<ArtifactAction>(['read', 'write', 'share', 'export', 'delete']);
const AGENT_KINDS = new Set<AgentKind>(['person', 'org', 'service']);

/** Resolve the acting scope: a person (session subject) or an org (steward-gated). Returns the read/
 *  write seam over the right vault + the KV cache key, or an error Response. */
async function scopeFor(request: Request, env: FnContext['env'], person: string, org?: string): Promise<
  | { ok: true; owner: string; ownerKind: AgentKind; read: () => Promise<LibraryArtifact[]>; write: (list: LibraryArtifact[]) => Promise<void> }
  | { ok: false; res: Response }
> {
  const bearer = (request.headers.get('authorization') ?? '').slice(7);
  if (org) {
    const orgSA = org.toLowerCase();
    // Authorization to act FOR the org is a stewardship wire, re-verified downstream by the org DO.
    const wire = await stewardWireFor(env, person, orgSA);
    if (!wire) return { ok: false, res: jsonCors({ error: 'not a steward of this organization' }, request, 403) };
    const { orgVault } = await import('../lib/org-vault');
    const vault = await orgVault(env, orgSA);
    if (!vault) return { ok: false, res: jsonCors({ error: 'organization storage not enabled' }, request, 503) };
    return {
      ok: true, owner: orgSA, ownerKind: 'org',
      read: async () => ((await vault.get('library.index')) as LibraryArtifact[] | null) ?? [],
      write: async (list) => { await vault.set('library.index', list); },
    };
  }
  // Person scope — authoritative vault record + KV cache (skills.data pattern).
  const { readCapabilityRecord, writeCapabilityRecord } = await import('../lib/capability-record');
  return {
    ok: true, owner: person, ownerKind: 'person',
    read: async () => {
      const auth = await readCapabilityRecord<LibraryArtifact[]>(env, person, bearer, 'library.index');
      if (Array.isArray(auth)) { await env.AUTH_CODES.put(`library:${person}`, JSON.stringify(auth)); return auth; }
      return JSON.parse((await env.AUTH_CODES.get(`library:${person}`)) ?? '[]') as LibraryArtifact[];
    },
    write: async (list) => {
      await env.AUTH_CODES.put(`library:${person}`, JSON.stringify(list));
      await writeCapabilityRecord(env, person, bearer, 'library.index', list);
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
  const artifacts = withEffectiveGrants(await scope.read());
  // Pending access requests addressed to this owner (the "someone wants access" inbox).
  const requests = (await readRequests(env, scope.owner)).filter((r) => r.status === 'pending');
  return jsonCors({ owner: scope.owner, ownerKind: scope.ownerKind, artifacts, requests }, request);
};

// POST — one of: save (upsert artifact), delete (by id), grant (give an agent access to an artifact),
// revoke (a grant). The index is small; each is an atomic read-modify-write.
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as {
    action?: string; org?: string; artifact?: Partial<LibraryArtifact>; artifacts?: Partial<LibraryArtifact>[]; id?: string;
    grant?: { granteeAddress?: string; granteeKind?: string; granteeLabel?: string; actions?: string[]; validUntil?: number };
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
      return jsonCors({ ok: true, artifact: entry }, request);
    }
    case 'save-batch': {
      // Bulk upload (drag-and-drop of many files) — one read-modify-write, atomic.
      if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) return jsonCors({ error: 'artifacts[] required' }, request, 400);
      const saved = (await Promise.all(body.artifacts.slice(0, 200).map((a) => upsert(list, a)))).filter(Boolean);
      await scope.write(list.slice(0, 200));
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
      await scope.write(next);
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
      await appendControlEvent(env, person as Address, 'grant-issued').catch(() => undefined);
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
      await appendControlEvent(env, person as Address, 'grant-revoked').catch(() => undefined);
      return jsonCors({ ok: true, artifact: art }, request);
    }
    case 'open': {
      // Cross-vault READ (Phase 3): the requester presents its authority; the OWNER's origin re-checks
      // the grant against its authoritative list (fail-closed) and releases an audience-bound copy.
      const ownerScope = typeof body.ownerScope === 'string' ? body.ownerScope : person;
      const ownerKind: AgentKind = body.ownerKind === 'org' ? 'org' : 'person';
      const ownerList = await readOwnerList(env, ownerScope, ownerKind);
      const art = ownerList.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact' }, request, 404);
      const holds = ownerScope === person || activeEffectiveGrants(ownerList, art).some((g) => g.grantee.address.toLowerCase() === person.toLowerCase());
      if (!holds) return jsonCors({ error: 'access to this artifact was revoked or never granted' }, request, 403);
      await appendReadReceipt(env, ownerScope, person, art.id).catch(() => undefined);
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
      // Publish a signed skill RELEASE (Phase 5) — owner-gated, append-only, version-monotonic. Only a
      // skill or a bundle folder is publishable; the acting principal is the owner + publisher.
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      if (art.kind !== 'skill' && !art.isFolder) return jsonCors({ error: 'only a skill or a bundle folder can be published as a release' }, request, 400);
      const release = await mintRelease(env, person, art, list);
      art.releases = [...(art.releases ?? []), release];
      await scope.write(list);
      await appendControlEvent(env, person as Address, 'credential-issued').catch(() => undefined);
      return jsonCors({ ok: true, artifact: art, release }, request);
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
  };
  if (idx >= 0) { entry.grants = list[idx]!.grants; list[idx] = entry; } else list.push(entry);
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

/** Read the OWNER's authoritative library list — the origin acting as the owner's vault resource server
 *  (Phase 3). In this demo the shared worker plays both A's vault and B's client; a real deployment would
 *  make an A2A/MCP call to A's vault. Person: the KV-cached index; org: the org vault index. */
async function readOwnerList(env: FnContext['env'], ownerScope: string, ownerKind: AgentKind): Promise<LibraryArtifact[]> {
  if (ownerKind === 'org') {
    const { orgVault } = await import('../lib/org-vault');
    const vault = await orgVault(env, ownerScope.toLowerCase());
    return vault ? (((await vault.get('library.index')) as LibraryArtifact[] | null) ?? []) : [];
  }
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

/** Append an audience-bound read receipt to the owner's read log (evidence the release happened). */
async function appendReadReceipt(env: FnContext['env'], ownerScope: string, reader: string, artifactId: string): Promise<void> {
  const key = `library:reads:${ownerScope}`;
  const l = JSON.parse((await env.AUTH_CODES.get(key)) ?? '[]') as unknown[];
  l.push({ reader, artifactId, at: Date.now() });
  await env.AUTH_CODES.put(key, JSON.stringify(l.slice(-500)));
}

interface AccessRequest { requester: string; artifactId: string; artifactName?: string; actions: ArtifactAction[]; at: number; status: 'pending' | 'granted' }
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
