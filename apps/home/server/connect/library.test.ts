import { describe, it, expect, beforeAll } from 'vitest';
import { generateBrokerKeypair, mintAgentSession } from '@agenticprimitives/connect';
import { resolveOrigin } from '../_lib/origin';
import { onRequestGet, onRequestPost } from './library';

// Acts as a demo user (the sanctioned "act as" path is a home-session JWT minted the same way
// /connect/demo-signin mints one — server/connect/demo-accounts.ts). We reuse getServer(env)'s own
// signer so the token verifies against the same JWKS, and rely on the KV-cache path (no
// A2A_CUSTODY_URL) so the handler is exercised self-contained.

// Nathan — a stand-in for one of the demo users custodied in demo-sso-next (DEMO_PERSONA_KEYS).
const DEMO_SA = '0x1111111111111111111111111111111111111111';
const TEAM_SA = '0x2222222222222222222222222222222222222222'; // an org grantee

function makeKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.get(k) ?? null; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
    _map: m,
  };
}

let env: any;
let token: string;
let iss: string;
const url = 'https://home.test/connect/library';

async function mint(env: any, sa: string = DEMO_SA): Promise<{ token: string; iss: string }> {
  const { getServer } = await import('../_lib/server-broker');
  const { signer } = await getServer(env);
  const req = new Request(url);
  const issuer = resolveOrigin(req, env);
  const t = await mintAgentSession(
    {
      sub: `eip155:84532:${sa}` as any,
      principal: { kind: 'siwe-eoa', id: sa, assurance: 'onchain-confirmed', role: 'custody-grade' } as any,
      assurance: 'onchain-confirmed',
      aud: 'demo-sso',
      iss: issuer,
      ttlSeconds: 3600,
    },
    signer,
  );
  return { token: t, iss: issuer };
}

beforeAll(async () => {
  const kp = await generateBrokerKeypair('ES256');
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  env = {
    AUTH_CODES: makeKV(),
    BROKER_PRIVATE_JWK: JSON.stringify(privateJwk),
    BROKER_KID: 'test-broker',
    DEMO_SSO_AUD: 'demo-sso',
    RPC_URL: 'http://localhost:0',
    // Register the demo user as a custodied persona so the grant can server-side-sign the entitlement VC.
    DEMO_PERSONA_KEYS: JSON.stringify({ [DEMO_SA]: `0x${'11'.repeat(32)}` }),
    // no A2A_CUSTODY_URL → capability-record read/write no-op; the KV cache is authoritative for the test.
  };
  ({ token, iss } = await mint(env));
});

const post = (body: unknown) =>
  onRequestPost({
    request: new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env,
  } as any);
const get = () => onRequestGet({ request: new Request(url, { headers: { authorization: `Bearer ${token}` } }), env } as any);

describe('/connect/library — as a demo user (person scope)', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await onRequestGet({ request: new Request(url), env } as any);
    expect(res.status).toBe(401);
  });

  it('starts empty', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ownerKind).toBe('person');
    expect(b.artifacts).toEqual([]);
  });

  it('saves a SKILL.md and a GraphDB .ttl (multi-source)', async () => {
    const skill = await (await post({ action: 'save', artifact: { id: 'create-skill', kind: 'skill', name: 'create-skill', source: 'blob', bytesB64: btoa('# Create Skill\n') } })).json();
    expect(skill.ok).toBe(true);
    expect(skill.artifact.source).toBe('blob');
    expect(skill.artifact.version).toBe(1); // append-only version axis starts at 1
    expect(skill.artifact.contentCommitment).toMatch(/^0x[0-9a-f]{64}$/); // SHA-256 content commitment for a blob

    // A .ttl that lives in GraphDB — a non-unstructured source (spec 335 §5.1).
    const ttl = await (await post({ action: 'save', artifact: { id: 'faith-ttl', kind: 'ttl', name: 'faith.ttl', source: 'graphdb', pointer: 'graphdb:faith/ontology' } })).json();
    expect(ttl.ok).toBe(true);
    expect(ttl.artifact.source).toBe('graphdb');
    expect(ttl.artifact.pointer).toBe('graphdb:faith/ontology');
    expect(ttl.artifact.contentCommitment).toBeUndefined(); // non-blob: commitment lives with the owning store

    const list = await (await get()).json();
    expect(list.artifacts.map((a: any) => a.id).sort()).toEqual(['create-skill', 'faith-ttl']);
  });

  it('bulk-uploads many files in one save-batch (drag-and-drop)', async () => {
    const artifacts = [
      { name: 'a.md', kind: 'md', source: 'blob', bytesB64: btoa('a') },
      { name: 'logo.png', kind: 'image', source: 'blob', bytesB64: btoa('img') },
      { name: 'notes.md', kind: 'md', source: 'blob', bytesB64: btoa('n') },
    ];
    const res = await post({ action: 'save-batch', artifacts });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(3);
    const list = await (await get()).json();
    // the two originals + the three uploaded
    expect(list.artifacts.length).toBe(5);
    expect(list.artifacts.some((a: any) => a.name === 'logo.png' && a.kind === 'image')).toBe(true);
  });

  it('grants another agent (an organization) access — mints an entitlement + emits a native notification', async () => {
    const res = await post({ action: 'grant', id: 'faith-ttl', grant: { granteeAddress: TEAM_SA, granteeKind: 'org', granteeLabel: 'Laos hotspot team', actions: ['read', 'share'] } });
    expect(res.status).toBe(200);
    const b = await res.json();
    const grant = b.artifact.grants[0];
    expect(grant.grantee.address).toBe(TEAM_SA.toLowerCase());
    expect(grant.grantee.kind).toBe('org');
    expect(grant.actions).toEqual(['read', 'share']);
    // entitlement minted, keyed on the artifact identity (uniform across sources)
    expect(b.entitlementId).toMatch(/^ent-/);
    expect(grant.entitlementId).toBe(b.entitlementId);
    expect(grant.resource).toBe('artifact:faith-ttl');
    // a SIGNED AgenticEntitlementCredentialV1 was minted (owner is the issuer)
    expect(b.signed).toBe(true);
    expect(grant.signed).toBe(true);
    expect(b.credential.issuer).toBe(DEMO_SA);
    expect(b.credential.credentialSubject.resource).toBe('artifact:faith-ttl');
    expect(b.credential.proof).toBeTruthy();
    // a paired scoped, revocable cross-principal DELEGATION was minted (owner → grantee, ADR-0019)
    expect(b.delegation).toBeTruthy();
    expect(b.delegation.delegator).toBe(DEMO_SA);
    expect(b.delegation.delegate.toLowerCase()).toBe(TEAM_SA.toLowerCase());
    expect(b.delegation.signature).toMatch(/^0x/);
    expect(grant.delegation?.delegator).toBe(DEMO_SA);
    // native notification landed on the control-event feed (out-of-the-box integration)
    const ev = JSON.parse((await env.AUTH_CODES.get(`home-control:${DEMO_SA}`)) ?? '[]');
    expect(ev.some((e: any) => e.eventType === 'grant-issued')).toBe(true);
  });

  it('advances the version on every re-save (append-only axis)', async () => {
    await post({ action: 'save', artifact: { id: 'versioned', kind: 'md', name: 'v.md', source: 'blob', bytesB64: btoa('one') } });
    const again = await (await post({ action: 'save', artifact: { id: 'versioned', kind: 'md', name: 'v.md', source: 'blob', bytesB64: btoa('two') } })).json();
    expect(again.artifact.version).toBe(2);
  });

  it('writes a per-artifact content.artifact.<id> vault record on save, and clears it on delete (addressable via ap-vault)', async () => {
    await post({ action: 'save', artifact: { id: 'addressable-doc', kind: 'md', name: 'a.md', source: 'blob', bytesB64: btoa('hello-addr') } });
    const key = `library:${DEMO_SA}:content.artifact.addressable-doc`;
    const rec = JSON.parse((await env.AUTH_CODES.get(key)) ?? 'null');
    expect(rec).toBeTruthy();
    expect(rec.bytesB64).toBe(btoa('hello-addr'));       // the servable content view
    expect(rec.commitment).toMatch(/^0x[0-9a-f]{64}$/);  // SHA-256 content commitment
    // deleting the artifact removes its per-artifact record too
    await post({ action: 'delete', id: 'addressable-doc' });
    expect(await env.AUTH_CODES.get(key)).toBeNull();
  });

  it('publishes a signed, version-monotonic skill release with a location-independent id (Phase 5)', async () => {
    await post({ action: 'save', artifact: { id: 'pub-skill', kind: 'skill', name: 'triage-skill', source: 'blob', bytesB64: btoa('# Triage\n') } });
    const r1 = await (await post({ action: 'publish', id: 'pub-skill' })).json();
    expect(r1.ok).toBe(true);
    expect(r1.release.version).toBe('1.0.0');
    expect(r1.release.canonicalId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r1.release.releaseId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r1.release.owner).toBe(DEMO_SA);
    expect(r1.release.publisher).toBe(DEMO_SA);
    // DEMO_SA is a custodied persona (DEMO_PERSONA_KEYS) → the publisher signs the releaseId
    expect(r1.release.signed).toBe(true);
    expect(r1.release.signature).toMatch(/^0x/);

    // a second publish advances the version; the canonical id (derived from the skill name, not its
    // location) is stable, while the release id changes
    const r2 = await (await post({ action: 'publish', id: 'pub-skill' })).json();
    expect(r2.release.version).toBe('2.0.0');
    expect(r2.release.canonicalId).toBe(r1.release.canonicalId);
    expect(r2.release.releaseId).not.toBe(r1.release.releaseId);
    expect(r2.artifact.releases.length).toBe(2);

    // spec 398 §6.2 — a PAGE (md / json-ld) publishes as a release naming its content commitment; its canonical id
    // is its own kind's (a page named like the skill is not that skill's release); an image or a ttl is refused
    await post({ action: 'save', artifact: { id: 'a-page', kind: 'md', name: 'triage-skill', source: 'blob', bytesB64: btoa('# Retreat\n') } });
    const p1 = await (await post({ action: 'publish', id: 'a-page' })).json();
    expect(p1.ok).toBe(true);
    expect(p1.release.version).toBe('1.0.0');
    expect(p1.release.canonicalId).not.toBe(r1.release.canonicalId);
    expect(p1.release.signed).toBe(true);
    await post({ action: 'save', artifact: { id: 'a-pic', kind: 'image', name: 'p.png', source: 'blob', bytesB64: btoa('x') } });
    expect((await post({ action: 'publish', id: 'a-pic' })).status).toBe(400);
    await post({ action: 'save', artifact: { id: 'a-ttl', kind: 'ttl', name: 'o.ttl', source: 'blob', bytesB64: btoa('x') } });
    expect((await post({ action: 'publish', id: 'a-ttl' })).status).toBe(400);
  });

  it('surfaces a grant under "Shared with me" for the grantee, and withdraws it on revoke', async () => {
    const GRANTEE = '0x3333333333333333333333333333333333333333';
    await post({ action: 'save', artifact: { id: 'shared-doc', kind: 'md', name: 'shared-doc.md', source: 'blob', bytesB64: btoa('hello') } });
    await post({ action: 'grant', id: 'shared-doc', grant: { granteeAddress: GRANTEE, granteeKind: 'person', actions: ['read'] } });

    const granteeTok = (await mint(env, GRANTEE)).token;
    const sharedGet = () => onRequestGet({ request: new Request(`${url}?lens=shared`, { headers: { authorization: `Bearer ${granteeTok}` } }), env } as any);
    const granteePost = (b: unknown) => onRequestPost({ request: new Request(url, { method: 'POST', headers: { authorization: `Bearer ${granteeTok}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env } as any);

    let shared = await (await sharedGet()).json();
    expect(shared.lens).toBe('shared');
    const row = shared.artifacts.find((a: any) => a.id === 'shared-doc');
    expect(row).toBeTruthy();
    expect(row.accessMode).toBe('Read-through');
    expect(row.sharedBy).toBe(DEMO_SA); // the owning (person) vault
    expect(row.myActions).toEqual(['read']);

    // Phase 3 — cross-vault READ: the owner's origin re-checks the grant and releases a copy.
    const opened = await (await granteePost({ action: 'open', ownerScope: DEMO_SA, ownerKind: 'person', id: 'shared-doc' })).json();
    expect(opened.ok).toBe(true);
    expect(opened.servedBy).toBe(DEMO_SA);
    expect(opened.artifact.bytesB64).toBe(btoa('hello'));
    // a read receipt landed in the READER's OWN vault (content.receipt.*), not a shared KV log
    const receipts = (await env.AUTH_CODES.list()).keys.map((k: any) => k.name).filter((n: string) => n.startsWith(`library:${GRANTEE}:content.receipt.`));
    expect(receipts.length).toBeGreaterThan(0);

    // Revoking withdraws the federated inbound pointer AND fails a later read (fail-closed).
    await post({ action: 'revoke', id: 'shared-doc', grant: { granteeAddress: GRANTEE } });
    shared = await (await sharedGet()).json();
    expect(shared.artifacts.find((a: any) => a.id === 'shared-doc')).toBeUndefined();
    const denied = await granteePost({ action: 'open', ownerScope: DEMO_SA, ownerKind: 'person', id: 'shared-doc' });
    expect(denied.status).toBe(403);
  });

  it('lets an agent request access, surfaces it to the owner, and clears it on approve', async () => {
    const REQ = '0x4444444444444444444444444444444444444444';
    await post({ action: 'save', artifact: { id: 'req-doc', kind: 'md', name: 'req-doc.md', source: 'blob', bytesB64: btoa('x') } });
    const reqTok = (await mint(env, REQ)).token;
    const reqPost = (b: unknown) => onRequestPost({ request: new Request(url, { method: 'POST', headers: { authorization: `Bearer ${reqTok}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env } as any);

    // A read before any grant is refused (fail-closed).
    expect((await reqPost({ action: 'open', ownerScope: DEMO_SA, ownerKind: 'person', id: 'req-doc' })).status).toBe(403);
    // The requester asks the owner.
    expect((await (await reqPost({ action: 'request-access', ownerScope: DEMO_SA, id: 'req-doc', actions: ['read'] })).json()).status).toBe('requested');
    // The owner sees the pending request on their GET.
    const withReq = await (await get()).json();
    expect(withReq.requests.some((x: any) => x.requester === REQ && x.artifactId === 'req-doc')).toBe(true);
    // Owner approves by granting; the request clears and the read now succeeds.
    await post({ action: 'grant', id: 'req-doc', grant: { granteeAddress: REQ, granteeKind: 'person', actions: ['read'] } });
    const afterGrant = await (await get()).json();
    expect(afterGrant.requests.some((x: any) => x.requester === REQ && x.artifactId === 'req-doc')).toBe(false);
    expect((await (await reqPost({ action: 'open', ownerScope: DEMO_SA, ownerKind: 'person', id: 'req-doc' })).json()).ok).toBe(true);
  });

  it('binds a native discussion board to an artifact via its artifact ContextRef', async () => {
    const res = await post({ action: 'discuss', id: 'faith-ttl' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.contextRef).toEqual({ kind: 'artifact', id: 'artifact:faith-ttl', label: 'faith.ttl' });
    expect(b.discussionId).toBe('disc:artifact:faith-ttl'); // person-scope fallback binding
  });

  it('revokes a grant', async () => {
    const res = await post({ action: 'revoke', id: 'faith-ttl', grant: { granteeAddress: TEAM_SA } });
    const b = await res.json();
    expect(b.artifact.grants[0].revoked).toBe(true);
  });

  it('deletes an artifact', async () => {
    await post({ action: 'delete', id: 'create-skill' });
    const list = await (await get()).json();
    expect(list.artifacts.find((a: any) => a.id === 'create-skill')).toBeUndefined();
    expect(list.artifacts.some((a: any) => a.id === 'faith-ttl')).toBe(true);
  });

  it('cascades a FOLDER grant to every document under it (containment §7.2)', async () => {
    // Build reports/ → reports/2026 → a doc inside the nested folder.
    await post({ action: 'save', artifact: { name: 'briefs', isFolder: true } });
    await post({ action: 'save', artifact: { name: '2026', isFolder: true, folder: 'briefs' } });
    await post({ action: 'save-batch', artifacts: [{ name: 'jan.md', source: 'blob', folder: 'briefs/2026', bytesB64: btoa('jan') }] });

    // Grant an org on the TOP folder only.
    let list = (await (await get()).json()).artifacts;
    const top = list.find((a: any) => a.isFolder && a.name === 'briefs');
    const res = await post({ action: 'grant', id: top.id, grant: { granteeAddress: TEAM_SA, granteeKind: 'org', actions: ['read'] } });
    const b = await res.json();
    // The folder grant mints a CONTAINER-scoped entitlement, not a leaf artifact one.
    expect(b.artifact.grants[0].resource).toBe('container:briefs');
    // …paired with a folder-subtree-scoped delegation (read cascades to everything under it):
    // three caveats — vault-record scope (vault:library.briefs:*), timestamp, value-0.
    expect(b.delegation).toBeTruthy();
    expect(b.delegation.delegator).toBe(DEMO_SA);
    expect(b.delegation.delegate.toLowerCase()).toBe(TEAM_SA.toLowerCase());
    expect(b.delegation.caveats.length).toBe(3);

    // The nested document now shows the grant as an EFFECTIVE (inherited) grant.
    list = (await (await get()).json()).artifacts;
    const doc = list.find((a: any) => a.name === 'jan.md');
    expect(doc.grants).toEqual([]); // no direct grant on the doc
    const eff = doc.effectiveGrants ?? [];
    expect(eff.some((g: any) => g.grantee.address === TEAM_SA.toLowerCase() && g.inheritedFrom === 'briefs')).toBe(true);

    // Revoking the folder grant withdraws the cascaded access.
    await post({ action: 'revoke', id: top.id, grant: { granteeAddress: TEAM_SA } });
    list = (await (await get()).json()).artifacts;
    const doc2 = list.find((a: any) => a.name === 'jan.md');
    expect((doc2.effectiveGrants ?? []).length).toBe(0);
  });

  it('spec 412 — a public FOLDER cascades to its documents; a private declaration inside it holds; a re-save keeps the policy and the releases', async () => {
    await post({ action: 'save', artifact: { name: 'works', isFolder: true, folder: 'publishing' } });
    await post({ action: 'save-batch', artifacts: [
      { id: 'w-open', name: 'open.md', source: 'blob', folder: 'publishing/works', bytesB64: btoa('open') },
      { id: 'w-draft', name: 'draft.md', source: 'blob', folder: 'publishing/works', bytesB64: btoa('draft'), accessPolicy: 'private' },
    ] });
    let list = (await (await get()).json()).artifacts;
    // Absent is private, said explicitly.
    expect(list.find((a: any) => a.id === 'w-open').effectiveAccessPolicy).toBe('private');
    const folder = list.find((a: any) => a.isFolder && a.name === 'works' && a.folder === 'publishing');
    const flip = await post({ action: 'visibility', id: folder.id, accessPolicy: 'public' });
    expect((await flip.json()).artifact.accessPolicy).toBe('public');
    list = (await (await get()).json()).artifacts;
    expect(list.find((a: any) => a.id === 'w-open').effectiveAccessPolicy).toBe('public');
    expect(list.find((a: any) => a.id === 'w-draft').effectiveAccessPolicy).toBe('private');
    // The per-artifact record carries the declaration a document made itself.
    expect(JSON.parse(env.AUTH_CODES._map.get(`library:${DEMO_SA}:content.artifact.w-draft`)).accessPolicy).toBe('private');
    // A release, then a re-save without a policy: the version advances, the policy and the release chain stay.
    await post({ action: 'visibility', id: 'w-open', accessPolicy: 'public' });
    const pub = await (await post({ action: 'publish', id: 'w-open' })).json();
    expect(pub.release.version).toBe('1.0.0');
    const again = await (await post({ action: 'save', artifact: { id: 'w-open', name: 'open.md', source: 'blob', folder: 'publishing/works', bytesB64: btoa('open v2') } })).json();
    expect(again.artifact.version).toBe(2);
    expect(again.artifact.accessPolicy).toBe('public');
    expect(again.artifact.releases).toHaveLength(1);
    const pub2 = await (await post({ action: 'publish', id: 'w-open' })).json();
    expect(pub2.release.version).toBe('2.0.0');
    // A bad word is refused.
    expect((await post({ action: 'visibility', id: 'w-open', accessPolicy: 'everyone' })).status).toBe(400);
  });

  it('supports folders and cascades a folder delete', async () => {
    await post({ action: 'save', artifact: { name: 'reports', isFolder: true } });
    await post({ action: 'save-batch', artifacts: [{ name: 'q1.md', source: 'blob', folder: 'reports', bytesB64: btoa('q1') }] });
    let list = (await (await get()).json()).artifacts;
    const folder = list.find((a: any) => a.isFolder && a.name === 'reports');
    expect(folder).toBeTruthy();
    expect(list.some((a: any) => a.name === 'q1.md' && a.folder === 'reports')).toBe(true);
    await post({ action: 'delete', id: folder.id });
    list = (await (await get()).json()).artifacts;
    expect(list.some((a: any) => a.name === 'reports' || a.folder === 'reports')).toBe(false);
  });
});

// ORG scope — the catalog is read from the org's InteractionsDO (`content.get`). A refusal there used to render as an
// EMPTY library and let a save rewrite the whole index on top of it; it is now said, and nothing is written.
describe('/connect/library — org scope, when the org plane refuses the read', () => {
  const ORG_SA = '0x3333333333333333333333333333333333333333';
  const DO = 'https://a2a.test';
  const calls: Array<{ url: string; op: string; body: any }> = [];
  let contentGet: { status: number; body: Record<string, unknown> };
  let orgEnv: any;
  let realFetch: typeof fetch;

  beforeAll(() => {
    orgEnv = { ...env, AUTH_CODES: makeKV(), A2A_CUSTODY_URL: DO };
    // The person steward-links the org (the wire itself is re-verified by the DO, stubbed below).
    void orgEnv.AUTH_CODES.put(`related:${DEMO_SA}:${ORG_SA}`, JSON.stringify({ relationship: 'steward', stewardshipDelegation: { delegator: ORG_SA, delegate: DEMO_SA } }));
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (!u.startsWith(DO)) return realFetch(input as any, init);
      const op = u.split('/').pop() ?? '';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, op, body });
      if (op === 'status') return new Response(JSON.stringify({ deliveryGranted: true }), { status: 200 });
      if (op === 'content.get') return new Response(JSON.stringify(contentGet.body), { status: contentGet.status });
      if (op === 'content.put') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ error: 'unexpected op' }), { status: 404 });
    }) as typeof fetch;
    return () => { globalThis.fetch = realFetch; };
  });

  const orgGet = () => onRequestGet({ request: new Request(`${url}?org=${ORG_SA}`, { headers: { authorization: `Bearer ${token}` } }), env: orgEnv } as any);
  const orgPost = (b: unknown) => onRequestPost({ request: new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env: orgEnv } as any);

  it('reads the catalog the org plane holds, over the stewardship wire', async () => {
    contentGet = { status: 200, body: { ok: true, record: [{ id: 'a1', kind: 'md', name: 'note.md', source: 'blob', folder: 'publishing', contentType: 'text/markdown', size: 1, createdAt: 1, version: 1, grants: [] }] } };
    const res = await orgGet();
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ownerKind).toBe('org');
    expect(b.artifacts.map((a: any) => a.id)).toEqual(['a1']);
    const call = calls.filter((c) => c.op === 'content.get').pop()!;
    expect(call.body.resource).toBe('content.catalog');
    expect(call.body.stewardship).toEqual({ delegator: ORG_SA, delegate: DEMO_SA });
  });

  it('an ABSENT catalog is an empty library', async () => {
    contentGet = { status: 200, body: { ok: true, record: null } };
    const res = await orgGet();
    expect(res.status).toBe(200);
    expect((await res.json()).artifacts).toEqual([]);
  });

  it('a REFUSED read is said, never rendered as an empty library', async () => {
    contentGet = { status: 409, body: { error: 'no interactions grant — enable interactions for this agent first' } };
    const res = await orgGet();
    expect(res.status).toBe(503);
    const b = await res.json();
    expect(b.error).toMatch(/no interactions grant/);
    expect(b.upstreamStatus).toBe(409);
    expect(b.artifacts).toBeUndefined();
  });

  it('a save does not rewrite the index on top of a refused read', async () => {
    contentGet = { status: 401, body: { error: 'unauthorized: not a steward' } };
    const before = calls.filter((c) => c.op === 'content.put').length;
    const res = await orgPost({ action: 'save', org: ORG_SA, artifact: { name: 'new.md', source: 'blob', bytesB64: btoa('x') } });
    expect(res.status).toBe(503);
    expect(calls.filter((c) => c.op === 'content.put').length).toBe(before);
  });
});

// ORG scope — THE CATALOG IS AN INDEX. Bytes go to `content.artifact.<id>` records (strictly), the catalog entry
// keeps no `bytesB64`, and a GET hydrates on request (`?folder=`, `?name=`). A write past the cap is refused with
// a 413, never trimmed: the old `.slice(0, 200)` acknowledged a batch and dropped its tail (2026-09-27).
describe('/connect/library — org scope, index-only catalog', () => {
  const ORG_SA = '0x4444444444444444444444444444444444444444';
  const DO = 'https://a2a-index.test';
  const records = new Map<string, unknown>();
  let orgEnv: any;
  let realFetch: typeof fetch;

  beforeAll(() => {
    orgEnv = { ...env, AUTH_CODES: makeKV(), A2A_CUSTODY_URL: DO, LIBRARY_MAX_ARTIFACTS: '6' };
    void orgEnv.AUTH_CODES.put(`related:${DEMO_SA}:${ORG_SA}`, JSON.stringify({ relationship: 'steward', stewardshipDelegation: { delegator: ORG_SA, delegate: DEMO_SA } }));
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (!u.startsWith(DO)) return realFetch(input as any, init);
      const op = u.split('/').pop() ?? '';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (op === 'status') return new Response(JSON.stringify({ deliveryGranted: true }), { status: 200 });
      if (op === 'content.get') return new Response(JSON.stringify({ ok: true, record: records.get(body.resource) ?? null }), { status: 200 });
      if (op === 'content.put') { if (body.data === null) records.delete(body.resource); else records.set(body.resource, body.data); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response(JSON.stringify({ error: 'unexpected op' }), { status: 404 });
    }) as typeof fetch;
    return () => { globalThis.fetch = realFetch; };
  });

  const get = (q = '') => onRequestGet({ request: new Request(`${url}?org=${ORG_SA}${q}`, { headers: { authorization: `Bearer ${token}` } }), env: orgEnv } as any);
  const post = (b: unknown) => onRequestPost({ request: new Request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env: orgEnv } as any);

  it('a batch writes every file to its own record and keeps the catalog free of bytes', async () => {
    const res = await post({ action: 'save-batch', org: ORG_SA, artifacts: [
      { id: 'pkg', name: 'pkg', folder: 'skills', isFolder: true, source: 'blob', kind: 'md' },
      { id: 'f-skill', name: 'SKILL.md', folder: 'skills/pkg', source: 'blob', bytesB64: btoa('# pkg') },
      { id: 'f-lic', name: 'LICENSE', folder: 'skills/pkg', source: 'blob', bytesB64: btoa('Apache-2.0') },
    ] });
    expect(res.status).toBe(200);
    const catalog = records.get('content.catalog') as any[];
    expect(catalog.map((a) => a.id)).toEqual(['pkg', 'f-skill', 'f-lic']);
    expect(catalog.every((a) => a.bytesB64 === undefined)).toBe(true);
    expect(catalog.find((a) => a.id === 'f-lic').size).toBe(btoa('Apache-2.0').length);
    expect((records.get('content.artifact.f-lic') as any).bytesB64).toBe(btoa('Apache-2.0'));
    expect(records.has('content.artifact.pkg')).toBe(false);   // a folder has no content record
  });

  it('a plain GET is the index; ?folder= hydrates that subtree from the records', async () => {
    const plain = await (await get()).json();
    expect(plain.artifacts.find((a: any) => a.id === 'f-lic').bytesB64).toBeUndefined();
    const hydrated = await (await get('&folder=skills/pkg')).json();
    expect(hydrated.artifacts.find((a: any) => a.id === 'f-lic').bytesB64).toBe(btoa('Apache-2.0'));
    expect(hydrated.artifacts.find((a: any) => a.id === 'f-skill').bytesB64).toBe(btoa('# pkg'));
    const named = await (await get('&folder=skills&name=SKILL.md')).json();
    expect(named.artifacts.find((a: any) => a.id === 'f-skill').bytesB64).toBe(btoa('# pkg'));
    expect(named.artifacts.find((a: any) => a.id === 'f-lic').bytesB64).toBeUndefined();
  });

  it('a write past the cap is refused with the numbers, and nothing is trimmed', async () => {
    const before = (records.get('content.catalog') as any[]).length;
    const res = await post({ action: 'save-batch', org: ORG_SA, artifacts: [1, 2, 3, 4].map((i) => ({ id: `x${i}`, name: `x${i}.md`, folder: 'skills/pkg', source: 'blob', bytesB64: btoa(String(i)) })) });
    expect(res.status).toBe(413);
    const b = await res.json();
    expect(b.limit).toBe(6);
    expect(b.artifacts).toBe(before + 4);
    expect((records.get('content.catalog') as any[]).length).toBe(before);
  });

  it('an older inline entry migrates to its record on the next save', async () => {
    const catalog = records.get('content.catalog') as any[];
    catalog.push({ id: 'old', kind: 'md', name: 'old.md', source: 'blob', folder: 'skills/pkg', contentType: 'text/markdown', bytesB64: btoa('old'), size: 4, version: 1, grants: [] });
    records.set('content.catalog', catalog);
    const res = await post({ action: 'save', org: ORG_SA, artifact: { id: 'f-skill', name: 'SKILL.md', folder: 'skills/pkg', source: 'blob', bytesB64: btoa('# pkg v2') } });
    expect(res.status).toBe(200);
    const after = records.get('content.catalog') as any[];
    expect(after.find((a) => a.id === 'old').bytesB64).toBeUndefined();
    expect((records.get('content.artifact.old') as any).bytesB64).toBe(btoa('old'));
    expect((records.get('content.artifact.f-skill') as any).bytesB64).toBe(btoa('# pkg v2'));
  });

  it('keeps the REGISTRY EDITION a writer names beside its own save count, and keeps it across a re-save that says nothing', async () => {
    const first = await (await post({ action: 'save', artifact: { id: 'reg-doc', kind: 'skill', name: 'SKILL.md', source: 'blob', bytesB64: btoa('# one'), registry: { id: 'skill:ns/thing', version: 9, at: 1 } } })).json();
    expect(first.artifact.version).toBe(1);
    expect(first.artifact.registry).toEqual({ id: 'skill:ns/thing', version: '9', at: 1 });
    const again = await (await post({ action: 'save', artifact: { id: 'reg-doc', kind: 'skill', name: 'SKILL.md', source: 'blob', bytesB64: btoa('# two') } })).json();
    expect(again.artifact.version).toBe(2);
    expect(again.artifact.registry).toEqual({ id: 'skill:ns/thing', version: '9', at: 1 });
    const bad = await (await post({ action: 'save', artifact: { id: 'reg-doc2', kind: 'md', name: 'x.md', source: 'blob', bytesB64: btoa('x'), registry: { id: '', version: 3 } } })).json();
    expect(bad.artifact.registry).toBeUndefined();
  });
});
