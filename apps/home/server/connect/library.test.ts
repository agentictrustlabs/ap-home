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
