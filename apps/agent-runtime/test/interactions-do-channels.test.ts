// InteractionsDO board ops — reachable now that the DO has an injected seam (`InteractionsDeps`).
//
// The previous attempt at this file stubbed HTTP for the broker, GCP KMS, demo-mcp and the chain, and
// spent most of its length reconstructing production preconditions. That tests the stubs. `deps`
// replaces the two seams that actually matter — ERC-1271 verification and the vault tool call — so
// what runs here is the DO's own logic: the membership gate, topic visibility, posting, and the
// spec 340 W12 interaction view.
//
// The session gate is still REAL (see `interactions-do-gate.test.ts` for its own coverage): callers
// present ES256-signed tokens verified against a generated JWKS. Only the two external systems are
// injected, and production never passes `deps` — the Cloudflare binding constructs the DO with two
// arguments, so both fall through to the real implementations.
//
// THE GATE UNDER TEST is spec 322 §4: a caller is a member only if a CURRENT directory listing
// re-verifies its ERC-1271 proof AT GATE TIME. Index presence is never trust, because the index is
// writable under the execution grant — so the interesting test is the same listing ceasing to count
// the moment its proof stops verifying.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { InteractionsDO, type InteractionsDeps } from '../src/interactions-do.js';
import { REQUIRED_SCOPES as SOURCE_REQUIRED_SCOPES } from '../src/interactions-do.js';
import { buildVaultRecordScopeCaveat } from '@agenticprimitives/delegation';

const ORG = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const OUTSIDER = '0x9999999999999999999999999999999999999999';
const CHAIN = 84532;
const BROKER_ISS = 'https://home.example.test';
const AUD = 'demo-sso';
const JWKS_URL = 'https://home.example.test/.well-known/jwks.json';
const KID = 'test-key-1';
const caip = (a: string) => `eip155:${CHAIN}:${a}`;

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function brokerKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, jwks: { keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] } };
}

async function mint(privateKey: CryptoKey, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const si = `${b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' })))}.${b64url(
    enc.encode(JSON.stringify({ iss: BROKER_ISS, aud: AUD, sub, iat: now, exp: now + 3600, jti: crypto.randomUUID() })),
  )}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(si));
  return `${si}.${b64url(new Uint8Array(sig))}`;
}

/** The principal's vault + the chain, as injected seams rather than HTTP stubs. */
interface World {
  records: Map<string, unknown>;
  /** Flip to make every ERC-1271 verification fail — "the proof no longer holds". */
  proofsValid: boolean;
}

function depsFor(w: World): InteractionsDeps {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return {
    async erc1271() { return w.proofsValid; },
    async vaultTool(_grant, toolName, args) {
      const a = args as { recordType?: string; recordTypes?: string[]; data?: unknown };
      if (toolName === 'set_vault_record') { w.records.set(String(a.recordType), a.data); return ok({ ok: true }); }
      if (toolName === 'get_vault_records') {
        const out: Record<string, unknown> = {};
        for (const rt of a.recordTypes ?? []) if (w.records.has(rt)) out[rt] = w.records.get(rt);
        return ok({ ok: true, records: out });
      }
      if (toolName === 'get_vault_record') return ok({ ok: true, data: w.records.get(String(a.recordType)) ?? null });
      return ok({ ok: true, records: [...w.records.keys()].map((record_type) => ({ record_type, updated_at: '2026-08-02T00:00:00.000Z' })) });
    },
  };
}

// The grant must carry a CURRENT vault-record scope caveat: `grantIsCurrent` decodes it and requires
// every entry of REQUIRED_SCOPES. A grant missing one is "stale" and refused with 409 — which is the
// real mechanism by which a scope widening forces a steward re-enable, and worth building properly
// rather than stubbing past.
// IMPORTED, not copied. This list was a hand-kept duplicate, so widening the real one turned eleven
// tests red with `409` — which is the staleness mechanism working exactly as designed, reported as a
// test failure. Deriving it here means a scope widening is now a one-line change again.
const REQUIRED_SCOPES = [...SOURCE_REQUIRED_SCOPES];

const scopeCaveat = buildVaultRecordScopeCaveat([
  { server: 'demo-mcp', resources: REQUIRED_SCOPES, ops: ['read', 'write'] },
] as Parameters<typeof buildVaultRecordScopeCaveat>[0]);

const grantWire = {
  delegator: ORG, delegate: '0x4444444444444444444444444444444444444444',
  authority: `0x${'0'.repeat(64)}`,
  caveats: [{ enforcer: scopeCaveat.enforcer, terms: scopeCaveat.terms, args: '0x' }],
  salt: '0', signature: `0x${'ab'.repeat(65)}`,
};

let jwks: unknown;
let signer: CryptoKey;
let restoreFetch: () => void;
let w: World;
let doInstance: InteractionsDO;

beforeAll(async () => {
  const k = await brokerKey();
  jwks = k.jwks;
  signer = k.privateKey;
});

beforeEach(async () => {
  w = { records: new Map(), proofsValid: true };
  const original = globalThis.fetch;
  // Only the JWKS is still served over fetch — it is part of the session gate, which stays real.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    if (url.includes('jwks')) return new Response(JSON.stringify(jwks), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };

  const m = new Map<string, unknown>();
  m.set('state', { grant: grantWire });
  doInstance = new InteractionsDO(
    { storage: {
      async get(k: string) { return m.get(k); },
      async put(k: string, v: unknown) { m.set(k, v); },
      async delete(k: string) { m.delete(k); },
    } } as unknown as DurableObjectState,
    { RPC_URL: 'https://rpc.example.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.example.test',
      BROKER_ISS, BROKER_JWKS_URL: JWKS_URL, DEMO_SSO_AUD: AUD } as unknown as ConstructorParameters<typeof InteractionsDO>[1],
    depsFor(w),
  );
});

afterEach(() => restoreFetch());

function seedListing(displayName: string, subject: string) {
  const rows = (w.records.get('directory.data') as unknown[]) ?? [];
  w.records.set('directory.data', [...rows, {
    listing: {
      subject: caip(subject), displayName,
      publishedAt: new Date(Date.now() - 60_000).toISOString(),
      proof: { signature: `0x${'cd'.repeat(65)}` },
    },
  }]);
}

function seedOpenTopic(id = 'conv_abc') {
  w.records.set('conversation.index', [{
    descriptor: {
      version: 'ap.conversation.v1', id, owner: caip(ORG), title: 'General',
      participants: [caip(ORG)], participantPolicy: 'open-to-context',
      contextRefs: [{ kind: 'community', id: ORG.toLowerCase() }],
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    title: 'General', createdBy: caip(ORG), messages: [], participationPolicy: 'open',
  }]);
}

async function call(op: string, asSa: string, extra: Record<string, unknown> = {}) {
  const token = await mint(signer, caip(asSa));
  return doInstance.fetch(new Request(`https://do.test/interactions/${ORG}/${op}`, {
    method: 'POST',
    body: JSON.stringify({ session: token, ...extra }),
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
  }));
}

describe('membership is a re-verified proof, not an index entry (spec 322 §4)', () => {
  it('REFUSES a caller with no directory listing', async () => {
    const r = await call('channels.list', OUTSIDER);
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toMatch(/join this community first/);
  });

  // THE gate. The listing is present and current; only the ERC-1271 proof stops verifying. The index
  // is writable under the execution grant, so presence alone must never be trust.
  it('REFUSES a listed member whose proof no longer verifies', async () => {
    seedListing('Alice', MEMBER);
    w.proofsValid = false;
    expect((await call('channels.list', MEMBER)).status).toBe(403);
  });

  it('ADMITS a listed member whose proof verifies, and answers with their name', async () => {
    seedListing('Alice', MEMBER);
    const r = await call('channels.list', MEMBER);
    expect(r.status).toBe(200);
    const out = await r.json() as { ok: boolean; you: string };
    expect(out.ok).toBe(true);
    expect(out.you).toBe('Alice');
  });

  // One member's listing does not admit another's session: the gate matches on the SESSION's subject,
  // not on "some valid listing exists in this org".
  it('REFUSES an outsider even when someone else is listed', async () => {
    seedListing('Alice', MEMBER);
    expect((await call('channels.list', OUTSIDER)).status).toBe(403);
  });

  it('a listed member may set an org-local name, and that is how they are known', async () => {
    seedListing('Alice', MEMBER);
    const set = await call('directory.setLocalName', MEMBER, { displayName: 'Ali in Outreach' });
    expect(set.status).toBe(200);
    expect((await set.json() as { you: string }).you).toBe('Ali in Outreach');
    const listed = await (await call('channels.list', MEMBER)).json() as { you: string };
    expect(listed.you).toBe('Ali in Outreach');
  });

  it('REFUSES an address as a local name', async () => {
    seedListing('Alice', MEMBER);
    const r = await call('directory.setLocalName', MEMBER, { displayName: MEMBER });
    expect(r.status).toBe(400);
    expect((await r.json() as { code: string }).code).toBe('local_name_required');
  });

  it('REFUSES an outsider setting a local name', async () => {
    expect((await call('directory.setLocalName', OUTSIDER, { displayName: 'Eve' })).status).toBe(403);
  });
});

describe('topics are served as the Interactions they are (spec 340 W12)', () => {
  beforeEach(() => {
    seedListing('Alice', MEMBER);
    seedOpenTopic();
  });

  it('every topic carries its interaction view', async () => {
    const out = await (await call('channels.list', MEMBER)).json() as {
      channels: Array<{ title: string; interaction?: { interactionId: string; profileVersion: string } }>;
    };
    // The seeded topic plus the DEFAULTED "Welcome" topic every board opens with.
    expect(out.channels).toHaveLength(2);
    const seeded = out.channels.find((c) => c.interaction?.interactionId === 'ixn_conv_conv_abc');
    expect(seeded?.interaction?.profileVersion).toBe('direct/1.0.0');
    expect(out.channels.some((c) => c.title === 'Welcome')).toBe(true);
  });

  // Every board opens with a Welcome topic — created on first read, once, by the organization itself.
  it('a board is DEFAULTED with a Welcome topic, created once', async () => {
    const first = await (await call('channels.list', MEMBER)).json() as { channels: Array<{ title: string; createdBy?: string }> };
    const second = await (await call('channels.list', MEMBER)).json() as { channels: Array<{ title: string }> };
    expect(first.channels.filter((c) => c.title === 'Welcome')).toHaveLength(1);
    expect(second.channels.filter((c) => c.title === 'Welcome')).toHaveLength(1);
  });

  // The W12 claim, end to end through the live route: an OPEN topic derives membership and stores no
  // participant list, so there is no per-topic copy of the org roster to go stale.
  it('an OPEN topic derives participation and stores no member list', async () => {
    const out = await (await call('channels.list', MEMBER)).json() as {
      channels: Array<{ interaction: { participationMode: string; participations: unknown[] } }>;
    };
    expect(out.channels[0]?.interaction.participationMode).toBe('derived');
    expect(out.channels[0]?.interaction.participations).toEqual([]);
  });

  it('the org custodies its own topics', async () => {
    const out = await (await call('channels.list', MEMBER)).json() as {
      channels: Array<{ interaction: { principal: string } }>;
    };
    expect(out.channels[0]?.interaction.principal).toBe(caip(ORG));
  });

  // The view is a PROJECTION computed on read from what the board already stores, so it never lands in
  // the vault. A stored copy is exactly what W12 exists to avoid — this asserts none appears.
  it('is NOT persisted — the vault gains no interaction record', async () => {
    await call('channels.list', MEMBER);
    for (const key of w.records.keys()) expect(key).not.toContain('interaction');
  });

  // The interaction view rides the same visibility gate as the topic itself: no membership, no topics,
  // and therefore no interaction ids leaked to a non-member.
  it('leaks no interaction to a non-member', async () => {
    const r = await call('channels.list', OUTSIDER);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('ixn_');
  });
});

describe('the injected seam is an injection point, not a bypass', () => {
  // Production constructs the DO with two arguments, so `deps` is undefined and both seams fall
  // through to the real chain read and the real bound-mint vault transport. Asserted because a seam
  // that could be reached from config would be a way to turn off ERC-1271 verification in production.
  it('a DO built without deps does not take the injected path', async () => {
    const m = new Map<string, unknown>();
    m.set('state', { grant: grantWire });
    const prod = new InteractionsDO(
      { storage: {
        async get(k: string) { return m.get(k); },
        async put(k: string, v: unknown) { m.set(k, v); },
        async delete(k: string) { m.delete(k); },
      } } as unknown as DurableObjectState,
      { RPC_URL: 'https://rpc.example.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.example.test',
        BROKER_ISS, BROKER_JWKS_URL: JWKS_URL, DEMO_SSO_AUD: AUD } as unknown as ConstructorParameters<typeof InteractionsDO>[1],
    );
    const token = await mint(signer, caip(MEMBER));
    const r = await prod.fetch(new Request(`https://do.test/interactions/${ORG}/channels.list`, {
      method: 'POST', body: JSON.stringify({ session: token }), headers: { authorization: `Bearer ${token}` },
    }));
    // It reaches the REAL vault transport, which is unconfigured here and fails closed — the point
    // being that it did not silently use the test double.
    expect([409, 500, 503]).toContain(r.status);
  });
});

// THE ROOM SAYS SO — a membership recorded in the organization's vault is announced in its Welcome topic
// by the organization itself. The line is narration, never authority: the membership record is what the
// substrate reads, and a board that could not be written would never fail the membership.
describe('the Welcome topic narrates arrivals', () => {
  it('recording a membership posts a "joined" line, authored by the organization', async () => {
    seedListing('Alice', MEMBER);
    const r = await call('org.recordMembership', MEMBER, {
      record: {
        memberAgent: MEMBER, organizationAgent: ORG,
        roleAssignment: { materializedByDelegation: { delegate: ORG, delegator: MEMBER } },
      },
    });
    expect(r.status).toBe(200);
    const index = w.records.get('conversation.index') as Array<{ descriptor: { id: string }; title: string }>;
    const welcome = index.find((c) => c.title === 'Welcome');
    expect(welcome).toBeDefined();
    const messages = w.records.get(`conversation.topic:${welcome!.descriptor.id}`) as Array<{ envelope: { from: string; body?: { authorName?: string } } }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.envelope.from).toBe(caip(ORG));
    // The body is sealed in the org's body store (base64 under the topic's body resource) — it reads "joined".
    const bodies = [...w.records.values()]
      .filter((v): v is { b64: string } => !!v && typeof (v as { b64?: unknown }).b64 === 'string')
      .map((v) => Buffer.from(v.b64, 'base64').toString('utf8'));
    expect(bodies.some((b) => /joined\./.test(b))).toBe(true);
  });
});

// A MEMBERSHIP ENDS IN THE ORGANIZATION'S OWN RECORD (spec 324 §11) — leaving or removal stamps `endedAt` on the record
// and keeps it; nobody else may end it. Before this, a removed member stayed on the org agent's roster and an invitation
// back was refused as "already holds organization membership".
describe('org.endMembership', () => {
  const record = { memberAgent: MEMBER, organizationAgent: ORG, roleAssignment: { materializedByDelegation: { delegate: ORG, delegator: MEMBER } } };
  it('the member ends their own; the record is kept and stamped', async () => {
    seedListing('Alice', MEMBER);
    expect((await call('org.recordMembership', MEMBER, { record })).status).toBe(200);
    const r = await call('org.endMembership', MEMBER, { member: MEMBER });
    expect(r.status).toBe(200);
    const kept = w.records.get(`org.membership:member:${MEMBER}`) as { endedAt?: string; endReason?: string; memberAgent: string };
    expect(kept.memberAgent).toBe(MEMBER);
    expect(kept.endedAt).toBeTruthy();
    expect(kept.endReason).toBe('left');
  });
  it('a stranger cannot end somebody else\'s membership', async () => {
    seedListing('Alice', MEMBER);
    await call('org.recordMembership', MEMBER, { record });
    const r = await call('org.endMembership', OUTSIDER, { member: MEMBER });
    expect(r.status).toBe(403);
    expect((w.records.get(`org.membership:member:${MEMBER}`) as { endedAt?: string }).endedAt).toBeUndefined();
  });
});
