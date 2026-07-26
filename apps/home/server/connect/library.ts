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
import { signCredential } from '@agenticprimitives/verifiable-credentials';
import { getServer, ownIssuer, type FnContext } from '../_lib/server-broker';
import { isAllowedClientOrigin } from '../../src/lib/oidc-clients';
import { stewardWireFor, callInteractions } from './channels';
import { appendControlEvent } from './control-events';
import { demoPersonaFor, signDigestAsDemoPersona } from '../_lib/demo-custody';
import { CHAIN_ID } from '../../src/lib/chain';

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
  /** The entitlement resource this grant authorizes: `artifact:<id>` — uniform across sources. */
  resource?: string;
  /** Reference to the durable entitlement record (an AgenticEntitlementCredentialV1 downstream). */
  entitlementId?: string;
  /** True when a signed AgenticEntitlementCredentialV1 was minted (owner ERC-1271 proof). */
  signed?: boolean;
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
  grants: ArtifactGrant[];
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
  const org = new URL(request.url).searchParams.get('org') ?? undefined;
  const scope = await scopeFor(request, env, person, org);
  if (!scope.ok) return scope.res;
  return jsonCors({ owner: scope.owner, ownerKind: scope.ownerKind, artifacts: await scope.read() }, request);
};

// POST — one of: save (upsert artifact), delete (by id), grant (give an agent access to an artifact),
// revoke (a grant). The index is small; each is an atomic read-modify-write.
export const onRequestPost = async ({ request, env }: FnContext): Promise<Response> => {
  const person = await personFrom(request, env);
  if (!person) return jsonCors({ error: 'home session required' }, request, 401);
  const body = (await request.json().catch(() => null)) as {
    action?: string; org?: string; artifact?: Partial<LibraryArtifact>; artifacts?: Partial<LibraryArtifact>[]; id?: string;
    grant?: { granteeAddress?: string; granteeKind?: string; granteeLabel?: string; actions?: string[]; validUntil?: number };
  } | null;
  if (!body?.action) return jsonCors({ error: 'action required' }, request, 400);

  const scope = await scopeFor(request, env, person, body.org);
  if (!scope.ok) return scope.res;
  const list = await scope.read();

  switch (body.action) {
    case 'save': {
      const entry = upsert(list, body.artifact);
      if (!entry) return jsonCors({ error: 'artifact.name required' }, request, 400);
      await scope.write(list.slice(0, 200));
      return jsonCors({ ok: true, artifact: entry }, request);
    }
    case 'save-batch': {
      // Bulk upload (drag-and-drop of many files) — one read-modify-write, atomic.
      if (!Array.isArray(body.artifacts) || body.artifacts.length === 0) return jsonCors({ error: 'artifacts[] required' }, request, 400);
      const saved = body.artifacts.slice(0, 200).map((a) => upsert(list, a)).filter(Boolean);
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
      const resource = `artifact:${art.id}`;
      const entitlementId = `ent-${Math.abs(hash(`${resource}${g.granteeAddress}${Date.now()}`)).toString(36)}`;
      // Mint the SIGNED entitlement credential (owner SA = issuer, ERC-1271 proof).
      const { credential, signed } = await mintEntitlementCredential(env, person, { entitlementId, resource, grantee: g.granteeAddress.toLowerCase(), actions, validUntil: typeof g.validUntil === 'number' ? g.validUntil : undefined });
      art.grants = art.grants.filter((x) => x.grantee.address.toLowerCase() !== g.granteeAddress!.toLowerCase());
      art.grants.push({
        grantee: { address: g.granteeAddress.toLowerCase(), kind, label: g.granteeLabel?.slice(0, 80) },
        actions, grantedAt: Date.now(), validUntil: typeof g.validUntil === 'number' ? g.validUntil : undefined,
        resource, entitlementId, signed,
      });
      await scope.write(list);
      await appendControlEvent(env, person as Address, 'grant-issued').catch(() => undefined);
      return jsonCors({ ok: true, artifact: art, entitlementId, signed, credential }, request);
    }
    case 'revoke': {
      const art = list.find((x) => x.id === body.id);
      if (!art) return jsonCors({ error: 'unknown artifact id' }, request, 404);
      const addr = body.grant?.granteeAddress?.toLowerCase();
      art.grants = art.grants.map((x) => (x.grantee.address === addr ? { ...x, revoked: true } : x));
      await scope.write(list);
      await appendControlEvent(env, person as Address, 'grant-revoked').catch(() => undefined);
      return jsonCors({ ok: true, artifact: art }, request);
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

/** Build + upsert one artifact into the list (mutating), preserving grants on update. Returns the
 *  entry, or null when the input is invalid (no name). Shared by `save` and `save-batch`. */
function upsert(list: LibraryArtifact[], a: Partial<LibraryArtifact> | undefined): LibraryArtifact | null {
  if (!a || typeof a.name !== 'string' || !a.name.trim()) return null;
  const kind = KINDS.has(String(a.kind)) ? (a.kind as LibraryArtifact['kind']) : 'md';
  const source = SOURCES.has(a.source as ArtifactSource) ? (a.source as ArtifactSource) : 'blob';
  const id = a.id && ID_RE.test(a.id) ? a.id : `art-${Math.abs(hash(`${a.name}${Date.now()}${Math.random()}`)).toString(36)}`;
  const folder = typeof a.folder === 'string' ? a.folder.replace(/^\/+|\/+$/g, '').slice(0, 256) : '';
  const entry: LibraryArtifact = {
    id, kind, name: a.name.trim().slice(0, 120), source, folder,
    isFolder: a.isFolder === true ? true : undefined,
    pointer: typeof a.pointer === 'string' ? a.pointer.slice(0, 512) : undefined,
    contentType: typeof a.contentType === 'string' ? a.contentType : defaultMime(kind),
    bytesB64: source === 'blob' && typeof a.bytesB64 === 'string' ? a.bytesB64.slice(0, 2_000_000) : undefined,
    size: typeof a.size === 'number' ? a.size : (a.bytesB64?.length ?? 0),
    createdAt: Date.now(),
    grants: [],
  };
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) { entry.grants = list[idx]!.grants; list[idx] = entry; } else list.push(entry);
  return entry;
}

function defaultMime(kind: LibraryArtifact['kind']): string {
  return kind === 'ttl' ? 'text/turtle' : kind === 'json-ld' ? 'application/ld+json' : kind === 'image' ? 'image/png' : 'text/markdown';
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
