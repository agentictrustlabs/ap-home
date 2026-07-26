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

async function mint(env: any): Promise<{ token: string; iss: string }> {
  const { getServer } = await import('../_lib/server-broker');
  const { signer } = await getServer(env);
  const req = new Request(url);
  const issuer = resolveOrigin(req, env);
  const t = await mintAgentSession(
    {
      sub: `eip155:84532:${DEMO_SA}` as any,
      principal: { kind: 'siwe-eoa', id: DEMO_SA, assurance: 'onchain-confirmed', role: 'custody-grade' } as any,
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

    // A .ttl that lives in GraphDB — a non-unstructured source (spec 335 §5.1).
    const ttl = await (await post({ action: 'save', artifact: { id: 'faith-ttl', kind: 'ttl', name: 'faith.ttl', source: 'graphdb', pointer: 'graphdb:faith/ontology' } })).json();
    expect(ttl.ok).toBe(true);
    expect(ttl.artifact.source).toBe('graphdb');
    expect(ttl.artifact.pointer).toBe('graphdb:faith/ontology');

    const list = await (await get()).json();
    expect(list.artifacts.map((a: any) => a.id).sort()).toEqual(['create-skill', 'faith-ttl']);
  });

  it('grants another agent (an organization) access to one artifact', async () => {
    const res = await post({ action: 'grant', id: 'faith-ttl', grant: { granteeAddress: TEAM_SA, granteeKind: 'org', granteeLabel: 'Laos hotspot team', actions: ['read', 'share'] } });
    expect(res.status).toBe(200);
    const b = await res.json();
    const grant = b.artifact.grants[0];
    expect(grant.grantee.address).toBe(TEAM_SA.toLowerCase());
    expect(grant.grantee.kind).toBe('org');
    expect(grant.actions).toEqual(['read', 'share']);
  });

  it('revokes a grant', async () => {
    const res = await post({ action: 'revoke', id: 'faith-ttl', grant: { granteeAddress: TEAM_SA } });
    const b = await res.json();
    expect(b.artifact.grants[0].revoked).toBe(true);
  });

  it('deletes an artifact', async () => {
    await post({ action: 'delete', id: 'create-skill' });
    const list = await (await get()).json();
    expect(list.artifacts.map((a: any) => a.id)).toEqual(['faith-ttl']);
  });
});
