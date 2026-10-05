// Spec 400 W2 (B3 + B7) — the organization's object as the place mentions and reactions LEAVE from, with no
// network: a member's post naming @goose-2 is handed to goose-2's own object (`/internal/admit-message`) as a message
// from the poster on the topic's thread with a `topic` context ref — and only when goose-2 holds the org's invitation
// record; an emoji added to a post fires the post author's `reaction` triggers (`/internal/fire-triggers`); a removal
// fires nothing; the org itself is excluded from mentions (its assistant hears it another way).
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
const GOOSE = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x5555555555555555555555555555555555555555';
const CARA = '0x6666666666666666666666666666666666666666';
/** What reached the members' objects: every fetch to A2A_TASKS, by agent id. */
let handed: Array<{ agent: string; path: string; body: Record<string, unknown> }>;
const NAMES: Record<string, string> = { 'goose-2.svc': GOOSE, 'stranger.svc': STRANGER, 'org.org': ORG };

beforeAll(async () => { const k = await brokerKey(); jwks = k.jwks; signer = k.privateKey; });
beforeEach(async () => {
  w = { records: new Map(), proofsValid: true };
  // EACH TEST ITS OWN SINK, captured by the stub: a late fire-and-forget delivery from the previous test lands in THAT
  // test's array, never this one's (CI flake 2026-10-05 — one test saw another's admission).
  const sink: typeof handed = [];
  handed = sink;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    if (url.includes('jwks')) return new Response(JSON.stringify(jwks), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
  const m = new Map<string, unknown>();
  m.set('state', { grant: grantWire });
  const A2A_TASKS = {
    idFromName: (n: string) => n,
    get: (id: string) => ({ fetch: async (req: Request) => { sink.push({ agent: id, path: new URL(req.url).pathname, body: await req.json() as Record<string, unknown> }); return new Response(JSON.stringify({ ok: true, fired: [] }), { headers: { 'content-type': 'application/json' } }); } }),
  };
  doInstance = new InteractionsDO(
    { storage: { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); }, async delete(k: string) { m.delete(k); } } } as unknown as DurableObjectState,
    { RPC_URL: 'https://rpc.example.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.example.test', BROKER_ISS, BROKER_JWKS_URL: JWKS_URL, DEMO_SSO_AUD: AUD, A2A_INTERNAL_MARKER: 'marker-for-tests-0123456789abcdef', A2A_TASKS } as unknown as ConstructorParameters<typeof InteractionsDO>[1],
    { ...depsFor(w), resolveName: async (n) => (NAMES[n] ?? null) as never },
  );
});
afterEach(() => restoreFetch());

function seedListing(displayName: string, subject: string) {
  const rows = (w.records.get('directory.data') as unknown[]) ?? [];
  w.records.set('directory.data', [...rows, { listing: { subject: caip(subject), displayName, publishedAt: new Date(Date.now() - 60_000).toISOString(), proof: { signature: `0x${'cd'.repeat(65)}` } } }]);
}
function seedOpenTopic(id = 'conv_abc') {
  w.records.set('conversation.index', [{ descriptor: { version: 'ap.conversation.v1', id, owner: caip(ORG), title: 'Retreat', participants: [caip(ORG)], participantPolicy: 'open-to-context', contextRefs: [{ kind: 'community', id: ORG.toLowerCase() }], createdAt: '2026-08-01T00:00:00.000Z' }, title: 'Retreat', createdBy: caip(ORG), messages: [], participationPolicy: 'open' }]);
}
async function call(op: string, asSa: string, extra: Record<string, unknown> = {}) {
  const token = await mint(signer, caip(asSa));
  return doInstance.fetch(new Request(`https://do.test/interactions/${ORG}/${op}`, { method: 'POST', body: JSON.stringify({ session: token, ...extra }), headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` } }));
}
// Deliveries are fire-and-forget after the post commits: wait for what a test EXPECTS (bounded), never a fixed sleep
// that a slow runner outlasts; a NEGATIVE check waits a little longer before asserting nothing arrived.
const settle = () => new Promise((r) => setTimeout(r, 300));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 10));
}

describe('mentions leave the topic for the member (B3)', () => {
  it('a post naming @goose-2 is admitted to goose-2 on the topic thread; a non-member handle and the org itself are not', async () => {
    seedListing('Bob', MEMBER); seedOpenTopic();
    w.records.set(`org.invite:agent:${GOOSE}`, { invited: true });
    const r = await call('channels.post', MEMBER, { channelId: 'conv_abc', bodyText: '@goose-2 what is the plan? cc @stranger and @org' });
    expect(r.status).toBe(200);
    await until(() => handed.some((h) => h.path === '/internal/admit-message'));
    await settle(); // and nothing more (the non-member and the org must not follow)
    const admits = handed.filter((h) => h.path === '/internal/admit-message');
    expect(admits.map((h) => h.agent)).toEqual([GOOSE]);
    const env = admits[0]!.body.envelope as { from: string; to: string[]; conversationId: string; contextRefs: Array<{ kind: string; id: string; label?: string }>; actor?: string; subject: string };
    expect(env.from).toBe(caip(MEMBER));
    expect(env.to).toEqual([caip(GOOSE)]);
    expect(env.conversationId).toBe(`conv_topic-${ORG}-conv_abc`);
    expect(env.contextRefs).toEqual([{ kind: 'topic', id: `${ORG}:conv_abc`, label: 'Retreat' }]);
    expect(env.subject).toBe('@goose-2 in Retreat');
    expect(admits[0]!.body.bodyText).toBe('@goose-2 what is the plan? cc @stranger and @org');
    expect(admits[0]!.body.skill).toBe('messaging.mention');
  });
  it('a mention with no invitation record tells nobody', async () => {
    seedListing('Bob', MEMBER); seedOpenTopic();
    await call('channels.post', MEMBER, { channelId: 'conv_abc', bodyText: '@goose-2 anyone?' });
    await settle();
    expect(handed.filter((h) => h.path === '/internal/admit-message')).toHaveLength(0);
  });
});

describe('a reaction is a trigger source (B7)', () => {
  it("adding an emoji fires the post author's reaction triggers; removing it fires nothing", async () => {
    seedListing('Bob', MEMBER); seedListing('Cara', CARA); seedOpenTopic();
    const posted = await (await call('channels.post', MEMBER, { channelId: 'conv_abc', bodyText: 'I propose Friday' })).json() as { messageId: string };
    handed.length = 0; // cleared in place — the stub holds this test's array
    const r1 = await call('channels.react', CARA, { channelId: 'conv_abc', messageId: posted.messageId, emoji: '👍' });
    expect(r1.status).toBe(200);
    await until(() => handed.some((h) => h.path === '/internal/fire-triggers'));
    const fired = handed.filter((h) => h.path === '/internal/fire-triggers');
    expect(fired.map((h) => h.agent)).toEqual([MEMBER]);
    const source = fired[0]!.body.source as { kind: string; message: { profile: string; text: string; from: string; thread: string; topic: { org: string; channelId: string } } };
    expect(source.message).toMatchObject({ profile: 'reaction', text: '👍', from: CARA.toLowerCase(), thread: `conv_topic-${ORG}-conv_abc`, topic: { org: ORG, channelId: 'conv_abc' } });
    handed.length = 0; // cleared in place — the stub holds this test's array
    await call('channels.react', CARA, { channelId: 'conv_abc', messageId: posted.messageId, emoji: '👍' });   // toggle off
    await settle();
    expect(handed.filter((h) => h.path === '/internal/fire-triggers')).toHaveLength(0);
  });
});
