// THE WORKSPACE'S SIGNING WIRE (the last link of slice S5). A person, as the CUSTODIAN of a `.svc` they chartered, signs
// that agent's A2A signing wire for `library.granted.read` at their Home; the agent's InteractionsDO verifies and keeps it
// (`signing.wireEnable` → `signing.serviceWire`); #76's `library.granted.fetch` finds it (`internal.signing.wire`) and signs
// the request AS the workspace under it.
//
// What runs for real here: the InteractionsDO (session gate with an ES256 broker token, the store path, the internal
// lookup), `grantedReadSender` with NO injected wire (it reads the DO through `signingWireFor`), the delegated-task rail,
// and — at the publisher — `verifySessionWrappedSignature` + the real `grantedLibraryRead`. The chain is injected as ECDSA
// (the test "SA" is its custodian key's address, so ERC-1271 ≡ recover) and a revocation set.
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { keccak256, recoverAddress, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  buildMethodAuthorityCaveats, buildVaultRecordScopeCaveat, buildCaveat, encodeTimestampTerms, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms,
  hashDelegation, type Delegation, type EnforcerAddressMap,
} from '@agenticprimitives/delegation';
import { A2A_ANY_SKILL, checkSessionWireShape, hashA2aMessage, skillSelector, verifySessionWrappedSignature } from '@agenticprimitives/a2a';
import { delegatedInput, readDelegatedTask, toProfileMessage, type MessageV1 } from '@agenticprimitives/a2a/standard';
import { InteractionsDO } from '../src/interactions-do.js';
import { SERVICE_SIGNING_WIRE_KEY, SERVICE_SIGNING_WIRE_SKILLS, serviceSigningWireError, wireCovering } from '../src/agent-signing-wire.js';
import { grantedLibraryRead, libraryEntryScope, libraryInvoker, LIBRARY_GRANTED_FETCH, LIBRARY_GRANTED_READ, type LibraryEntry, type LibraryToolDeps } from '../src/library-tools.js';
import { grantedReadSender } from '../src/library-granted-fetch.js';
import type { Env, IncomingDelegation } from '../src/index.js';

const PUBLISHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const WORKSPACE_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const SESSION_PK = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const STRANGER_PK = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as const;
const PUBLISHER = privateKeyToAccount(PUBLISHER_PK).address.toLowerCase() as Address;
const WORKSPACE = privateKeyToAccount(WORKSPACE_PK).address.toLowerCase() as Address; // the .svc SA (its custodian's key)
const SESSION_KEY = privateKeyToAccount(SESSION_PK).address.toLowerCase() as Address;
const PERSON = ('0x' + 'c3'.repeat(20)) as Address; // the custodian person, signed in at Home
const CHAIN = 84532;
const DM = ('0x' + 'd0'.repeat(20)) as Address;
const VAULT = 'demo-mcp';
const MARKER = 'marker-for-tests-0123456789abcdef';
const E: EnforcerAddressMap = {
  delegationManager: DM,
  timestamp: ('0x' + '11'.repeat(20)) as Address,
  value: ('0x' + '12'.repeat(20)) as Address,
  allowedTargets: ('0x' + '13'.repeat(20)) as Address,
  allowedMethods: ('0x' + '14'.repeat(20)) as Address,
};
const NOW = Math.floor(Date.now() / 1000);
const ecdsa = async (signer: string, digest: Hex, signature: Hex) => (await recoverAddress({ hash: digest, signature }).catch(() => '0x')).toLowerCase() === signer.toLowerCase();

// ── the session gate (real): an ES256 broker token, verified against a JWKS served over fetch ──
const BROKER_ISS = 'https://home.example.test';
const AUD = 'demo-sso';
const KID = 'k1';
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let jwks: unknown;
let brokerSigner: CryptoKey;
async function mint(sub: string) {
  const enc = new TextEncoder();
  const si = `${b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' })))}.${b64url(enc.encode(JSON.stringify({ iss: BROKER_ISS, aud: AUD, sub: `eip155:${CHAIN}:${sub}`, iat: NOW, exp: NOW + 3600, jti: crypto.randomUUID() })))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, brokerSigner, enc.encode(si));
  return `${si}.${b64url(new Uint8Array(sig))}`;
}
beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }] };
  brokerSigner = kp.privateKey;
});
let restoreFetch: () => void;
beforeEach(() => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    if (url.includes('jwks')) return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = original; };
});
afterEach(() => restoreFetch());

/** The wire exactly as the Home's `issueAgentSigningWire` builds it: timestamp, allowedTargets [agent], allowedMethods. */
async function wireOf(o: { delegator?: Address; delegate?: Address; selectors?: Hex[]; signer?: Hex; targets?: Address[]; salt?: bigint } = {}): Promise<IncomingDelegation> {
  const delegator = o.delegator ?? WORKSPACE;
  const unsigned: Delegation = {
    delegator, delegate: o.delegate ?? SESSION_KEY, authority: `0x${'f'.repeat(64)}` as Hex, salt: o.salt ?? 21n, signature: '0x',
    caveats: [
      buildCaveat(E.timestamp, encodeTimestampTerms(0, NOW + 180 * 86_400)),
      buildCaveat(E.allowedTargets, encodeAllowedTargetsTerms(o.targets ?? [delegator])),
      buildCaveat(E.allowedMethods, encodeAllowedMethodsTerms(o.selectors ?? [skillSelector(LIBRARY_GRANTED_READ) as Hex])),
    ],
  };
  const signature = await sign({ hash: hashDelegation(unsigned, CHAIN, DM), privateKey: o.signer ?? WORKSPACE_PK, to: 'hex' });
  return { ...unsigned, salt: unsigned.salt.toString(), signature } as unknown as IncomingDelegation;
}

/** The workspace's InteractionsDO, with the chain injected. */
function workspaceObject(o: { isService?: boolean; seed?: Record<string, unknown> } = {}) {
  const storage = new Map<string, unknown>(Object.entries(o.seed ?? {}));
  const revoked = new Set<string>();
  const env = {
    RPC_URL: 'https://rpc.test', CHAIN_ID: String(CHAIN), MCP_URL: 'https://mcp.test', DELEGATION_MANAGER: DM,
    TIMESTAMP_ENFORCER: E.timestamp, ALLOWED_TARGETS_ENFORCER: E.allowedTargets, ALLOWED_METHODS_ENFORCER: E.allowedMethods,
    BROKER_ISS, BROKER_JWKS_URL: `${BROKER_ISS}/.well-known/jwks.json`, DEMO_SSO_AUD: AUD, A2A_INTERNAL_MARKER: MARKER,
  };
  const obj = new InteractionsDO(
    { storage: { async get(k: string) { return storage.get(k); }, async put(k: string, v: unknown) { storage.set(k, v); }, async delete(k: string) { storage.delete(k); } } } as never,
    env as never,
    {
      erc1271: (account, digest, signature) => ecdsa(account, digest, signature),
      isRevoked: async (d) => revoked.has(d.toLowerCase()),
      sessionKeyAddress: async () => SESSION_KEY,
      isService: async () => o.isService ?? true,
    },
  );
  const call = async (op: string, body: Record<string, unknown>, as: Address = PERSON) => {
    const r = await obj.fetch(new Request(`https://do/interactions/${WORKSPACE}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: await mint(as), ...body }) }));
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const internal = async (op: string, body: Record<string, unknown>) =>
    (await (await obj.fetch(new Request(`https://do/interactions/${WORKSPACE}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ap-internal': MARKER }, body: JSON.stringify(body) }))).json()) as Record<string, any>;
  return { obj, storage, revoked, env, call, internal };
}

describe('the service signing wire — the store (signing.wireEnable)', () => {
  it('a wire the CUSTODIAN signed, naming exactly library.granted.read, is stored under its own key and passes the A2A shape check', async () => {
    const w = workspaceObject();
    const wire = await wireOf();
    const r = await w.call('signing.wireEnable', { delegation: wire });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.hash).toBe(hashDelegation({ ...(wire as never as Delegation), salt: 21n }, CHAIN, DM));
    expect(r.body.skills).toEqual(['library.granted.read']);
    expect(w.storage.get(SERVICE_SIGNING_WIRE_KEY)).toMatchObject({ hash: r.body.hash, sessionKey: SESSION_KEY, enabledBy: PERSON });
    expect(w.storage.has('routing.orgWire')).toBe(false); // never the org consult wire's key
    const found = await w.internal('internal.signing.wire', { skill: LIBRARY_GRANTED_READ });
    expect(found.from).toBe(SERVICE_SIGNING_WIRE_KEY);
    expect(checkSessionWireShape(found.wire, { timestamp: E.timestamp, allowedMethods: E.allowedMethods }, NOW, { skill: LIBRARY_GRANTED_READ })).toBeNull();
    // status hands back the full struct (the Home needs it to revoke on chain)
    const st = await w.call('signing.wireStatus', {});
    expect(st.body).toMatchObject({ ok: true, wirePresent: true, sessionKey: SESSION_KEY, hash: r.body.hash });
    expect(st.body.wire.signature).toBe(wire.signature);
  });

  it('a NON-CUSTODIAN is refused: a wire whose signature does not verify against the service (ERC-1271) is not stored', async () => {
    const w = workspaceObject();
    const r = await w.call('signing.wireEnable', { delegation: await wireOf({ signer: STRANGER_PK }) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(`the signing wire's signature does not verify against ${WORKSPACE} — only the credential that custodies this service agent can sign it`);
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(false);
  });

  it('the ANY-SKILL sentinel is refused at store', async () => {
    const w = workspaceObject();
    const r = await w.call('signing.wireEnable', { delegation: await wireOf({ selectors: [A2A_ANY_SKILL as Hex] }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('a service signing wire must never carry the any-skill sentinel');
    const mixed = await w.call('signing.wireEnable', { delegation: await wireOf({ selectors: [skillSelector(LIBRARY_GRANTED_READ) as Hex, A2A_ANY_SKILL as Hex] }) });
    expect(mixed.body.error).toBe('a service signing wire must never carry the any-skill sentinel');
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(false);
  });

  it('OTHER selectors are refused at store — alongside the library read, or instead of it', async () => {
    const w = workspaceObject();
    const extra = await w.call('signing.wireEnable', { delegation: await wireOf({ selectors: [skillSelector(LIBRARY_GRANTED_READ) as Hex, skillSelector('discussion.consult') as Hex] }) });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/^a service signing wire names exactly library\.granted\.read — this one names other methods too \(0x/);
    const consultOnly = await w.call('signing.wireEnable', { delegation: await wireOf({ selectors: [skillSelector('discussion.consult') as Hex] }) });
    expect(consultOnly.body.error).toBe('session wire allowedMethods does not name the library.granted.read selector');
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(false);
  });

  it('refuses a wire to another delegate, aimed at another target, already revoked, or for an agent that is not a service', async () => {
    const w = workspaceObject();
    expect((await w.call('signing.wireEnable', { delegation: await wireOf({ delegate: PERSON }) })).body.error).toBe('the signing wire\'s delegate must be the interactions-session key');
    expect((await w.call('signing.wireEnable', { delegation: await wireOf({ targets: [PUBLISHER] }) })).body.error).toBe('the signing wire\'s allowedTargets must name exactly this service agent');
    const wire = await wireOf();
    w.revoked.add(hashDelegation({ ...(wire as never as Delegation), salt: 21n }, CHAIN, DM).toLowerCase());
    expect((await w.call('signing.wireEnable', { delegation: wire })).body.error).toBe('the signing wire is already revoked on-chain');
    const org = workspaceObject({ isService: false });
    const r = await org.call('signing.wireEnable', { delegation: await wireOf() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/is minted for a SERVICE agent/);
  });

  it('no session, no store', async () => {
    const w = workspaceObject();
    const r = await w.obj.fetch(new Request(`https://do/interactions/${WORKSPACE}/signing.wireEnable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delegation: await wireOf() }) }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(false);
  });

  it('the internal lookup is in-Worker only', async () => {
    const w = workspaceObject();
    const r = await w.obj.fetch(new Request(`https://do/interactions/${WORKSPACE}/internal.signing.wire`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skill: LIBRARY_GRANTED_READ }) }));
    expect(r.status).toBe(403);
  });
});

describe('the org consult wire is untouched', () => {
  it('an org\'s routing.orgWire is not clobbered; each method finds the wire that names it; internal.consult.orgWire is unchanged', async () => {
    const orgWire = await wireOf({ selectors: [skillSelector('discussion.consult') as Hex, skillSelector('archetype.ontologist') as Hex], salt: 5n });
    // An agent that holds both (possible only for one that is a service AND ran routing-enable — the keys are separate).
    const w = workspaceObject({ seed: { 'routing.orgWire': { wire: orgWire, hash: '0xorg', sessionKey: SESSION_KEY, enabledBy: PERSON, enabledAt: 'then' }, state: { grant: { delegator: WORKSPACE, delegate: SESSION_KEY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '0', signature: '0x' } } } });
    expect((await w.call('signing.wireEnable', { delegation: await wireOf() })).status).toBe(200);
    expect((w.storage.get('routing.orgWire') as { wire: unknown }).wire).toEqual(orgWire);
    expect((await w.internal('internal.signing.wire', { skill: 'discussion.consult' })).from).toBe('routing.orgWire');
    expect((await w.internal('internal.signing.wire', { skill: 'archetype.ontologist' })).wire).toEqual(orgWire);
    expect((await w.internal('internal.signing.wire', { skill: LIBRARY_GRANTED_READ })).from).toBe(SERVICE_SIGNING_WIRE_KEY);
  });

  it('wireCovering: with only an org wire that lacks the method, that wire is returned so the signer\'s shape check says what is missing', async () => {
    const consult = await wireOf({ selectors: [skillSelector('discussion.consult') as Hex] });
    expect(wireCovering({ service: null, org: consult }, E.allowedMethods, LIBRARY_GRANTED_READ)).toBe(consult);
    expect(wireCovering({ service: null, org: null }, E.allowedMethods, LIBRARY_GRANTED_READ)).toBeNull();
  });

  it('the permitted set is exactly the library read (a reviewed constant, not a request field)', () => {
    expect([...SERVICE_SIGNING_WIRE_SKILLS]).toEqual([LIBRARY_GRANTED_READ]);
    expect(serviceSigningWireError(undefined, { principal: WORKSPACE, sessionKey: SESSION_KEY, enforcers: { timestamp: E.timestamp, allowedTargets: E.allowedTargets, allowedMethods: E.allowedMethods }, nowSec: NOW })).toMatch(/signed delegation is required/);
  });
});

describe('revocation (signing.wireClear)', () => {
  it('a LIVE wire is not cleared by a session; once revoked on chain it is', async () => {
    const w = workspaceObject();
    const en = await w.call('signing.wireEnable', { delegation: await wireOf() });
    const live = await w.call('signing.wireClear', {});
    expect(live.status).toBe(409);
    expect(live.body.error).toMatch(/still live — its custodian revokes it on chain first/);
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(true);
    w.revoked.add(String(en.body.hash).toLowerCase());
    expect((await w.call('signing.wireClear', {})).body).toEqual({ ok: true, cleared: true });
    expect(w.storage.has(SERVICE_SIGNING_WIRE_KEY)).toBe(false);
    expect((await w.internal('internal.signing.wire', { skill: LIBRARY_GRANTED_READ })).wire).toBeNull();
  });
});

// ── END TO END: the stored wire signs #76's fetch, and the publisher's gate takes it as the workspace's ──
const catalog: LibraryEntry[] = [{ id: 'art-restricted', kind: 'md', name: 'work.md', folder: 'works/restricted', accessPolicy: 'private', version: 1 }];
const enc = (t: string) => btoa(unescape(encodeURIComponent(t)));
const publisherDeps: LibraryToolDeps = {
  readSubjectRecord: async (subject, type) => {
    if (subject !== PUBLISHER) return null;
    if (type === 'content.catalog') return structuredClone(catalog);
    return type === 'content.artifact.art-restricted' ? { id: 'art-restricted', bytesB64: enc('In the beginning') } : null;
  },
  grantChecks: {
    enforcers: E, vaultServer: VAULT, delegationDigest: (d) => hashDelegation(d, CHAIN, DM), isRevoked: async () => false,
    verifySignature: ({ signer, digest, signature }) => ecdsa(signer, digest, signature),
  },
};
async function grantToWorkspace() {
  const caveats = [
    ...buildMethodAuthorityCaveats({ target: PUBLISHER, method: LIBRARY_GRANTED_READ, enforcers: E, window: { validAfter: NOW - 60, validUntil: NOW + 3600 } }),
    buildVaultRecordScopeCaveat([{ server: VAULT, resources: [libraryEntryScope('art-restricted')], ops: ['read'] }]),
  ];
  const unsigned: Delegation = { delegator: PUBLISHER, delegate: WORKSPACE, authority: `0x${'f'.repeat(64)}` as Hex, caveats, salt: 7n, signature: '0x' };
  return { ...unsigned, salt: '7', signature: await sign({ hash: hashDelegation(unsigned, CHAIN, DM), privateKey: PUBLISHER_PK, to: 'hex' }) };
}

/** The publisher's task object: #74's door (verifySessionWrappedSignature with the wire's ERC-1271 ≡ ECDSA here), then the real granted read. */
function publisherTasks(seen: { senders: string[]; tasks: Map<string, { sender: string; body?: unknown; error?: string }>; revokedWire: Set<string> }) {
  const reply = (x: unknown) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  return {
    idFromName: (n: string) => n,
    get: (agent: string) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as Record<string, any>;
        if (new URL(req.url).pathname === '/internal/consult-artifact') {
          const t = seen.tasks.get(body.taskId);
          return reply(t && t.sender === body.caller ? { ok: true, body: t.body } : { ok: false, error: 'not the sender' });
        }
        const { rpc, principal } = body as { rpc: { id: string; method: string; params: Record<string, any> }; principal: { agent: string } };
        if (agent !== PUBLISHER) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'not the publisher' } });
        if (rpc.method === 'GetTask') {
          const t = seen.tasks.get(rpc.params.id)!;
          return reply({ jsonrpc: '2.0', id: rpc.id, result: { id: rpc.params.id, contextId: 'c', status: { state: t.body ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED', ...(t.error ? { message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: t.error }] } } : {}) }, artifacts: t.body ? [{ artifactId: 'a1', parts: [] }] : [] } });
        }
        const message = rpc.params.message as MessageV1;
        const ext = readDelegatedTask(message);
        if (!ext || 'error' in ext) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'no delegated task' } });
        const input = delegatedInput(message) as Record<string, unknown>;
        const deny = (m: string) => reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32001, message: m } });
        if (ext.sender.toLowerCase() !== principal.agent) return deny('message sender != authenticated caller');
        if (keccak256(toBytes(JSON.stringify(input))) !== ext.bodyHash) return deny('body hash mismatch');
        const ok = await verifySessionWrappedSignature({
          signer: ext.sender as Address, digest: hashA2aMessage(toProfileMessage(message, ext) as never), signature: ext.signature,
          enforcers: { timestamp: E.timestamp, allowedMethods: E.allowedMethods },
          verifyDelegationSig: async (d) => ecdsa(d.delegator, hashDelegation(d, CHAIN, DM), d.signature as Hex),
          isRevoked: async (d) => seen.revokedWire.has(hashDelegation(d, CHAIN, DM).toLowerCase()),
          skill: ext.skill,
        });
        if (!ok) return deny('message signature invalid');
        seen.senders.push(ext.sender.toLowerCase());
        const out = await grantedLibraryRead(publisherDeps, PUBLISHER, ext.sender, { ...input, grant: ext.delegation });
        const taskId = `0x${String(seen.tasks.size + 1).padStart(64, '0')}`;
        seen.tasks.set(taskId, out.read === true ? { sender: ext.sender.toLowerCase(), body: out } : { sender: ext.sender.toLowerCase(), error: String(out.refused) });
        return reply({ jsonrpc: '2.0', id: rpc.id, result: { task: { id: taskId, contextId: 'c', status: { state: 'TASK_STATE_SUBMITTED' } } } });
      },
    }),
  };
}

describe('end to end — the minted wire signs #76\'s fetch', () => {
  it('the publisher\'s gate accepts the message as the workspace\'s, and the real granted read answers', async () => {
    const w = workspaceObject();
    expect((await w.call('signing.wireEnable', { delegation: await wireOf() })).status).toBe(200);
    const seen = { senders: [] as string[], tasks: new Map(), revokedWire: new Set<string>() };
    const env = { ...w.env, A2A_TASKS: publisherTasks(seen), INTERACTIONS: { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => w.obj.fetch(r) }) } } as unknown as Env;
    // NO injected signingWire: the sender reads the workspace's InteractionsDO (`signingWireFor` → internal.signing.wire).
    const fetchGranted = grantedReadSender(env, { signRaw: async ({ hash }) => sign({ hash, privateKey: SESSION_PK, to: 'hex' }), everyMs: 1, deadlineMs: 2000 });
    const deps: LibraryToolDeps = { readSubjectRecord: async () => null, stewardOf: async () => ({ steward: true, because: 'you chartered it' }), fetchGranted };
    const ctx = { step: { toolId: LIBRARY_GRANTED_FETCH, args: {} }, index: 0, intent: { goal: 'read' } } as never;
    const out = (await libraryInvoker(deps, WORKSPACE, PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantToWorkspace() }, ctx)) as Record<string, any>;
    expect(out.read).toBe(true);
    expect(out.text).toBe('In the beginning');
    expect(seen.senders).toEqual([WORKSPACE]);

    // REVOKED on chain ⇒ the publisher's gate refuses the next message under it, at once.
    const st = await w.call('signing.wireStatus', {});
    seen.revokedWire.add(String(st.body.hash).toLowerCase());
    const after = (await libraryInvoker(deps, WORKSPACE, PERSON)(LIBRARY_GRANTED_FETCH, { publisher: PUBLISHER, id: 'art-restricted', grant: await grantToWorkspace() }, ctx)) as Record<string, any>;
    expect(after.read).toBe(false);
    expect(after.refused).toMatch(/message signature invalid/);
  });

  it('with no wire stored, the fetch is refused in words before anything is sent', async () => {
    const w = workspaceObject();
    const seen = { senders: [] as string[], tasks: new Map(), revokedWire: new Set<string>() };
    const env = { ...w.env, A2A_TASKS: publisherTasks(seen), INTERACTIONS: { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => w.obj.fetch(r) }) } } as unknown as Env;
    const sent = await grantedReadSender(env, { signRaw: async ({ hash }) => sign({ hash, privateKey: SESSION_PK, to: 'hex' }) })({ sender: WORKSPACE, publisher: PUBLISHER, grant: await grantToWorkspace() as never, input: { id: 'art-restricted' } });
    expect(sent.ok).toBe(false);
    expect((sent as { refused: string }).refused).toMatch(/holds no signing wire of its own .* its custodian signs one at their Home \(\/workspace-read\)/);
    expect(seen.senders).toEqual([]);
  });
});
