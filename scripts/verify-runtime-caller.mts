/**
 * Spec 372 S3c — the RUNTIME speaks as itself on the standard A2A 1.0 surface.
 *
 *   npx tsx scripts/verify-runtime-caller.mts [serviceSA] [targetName]
 *
 * The service agent chartered by `verify-runtime-member.mts` is the identity an outside runtime acts as. It
 * holds no Home session and is given none. What it holds is a SESSION WIRE: a narrow delegation from its own
 * Smart Agent to a key the runtime controls — timestamp-bounded, pinning `harness.ask` and nothing else,
 * signed by the agent's custody credential. Every request carries an assertion signed by that key, bound to
 * the method, the body, the host and the moment.
 *
 * The gate: admitted with the wire; refused without one, with a tampered body, with a wire pinned to another
 * skill, with a replay of the same assertion, with a stale assertion, and with a wire past its window. The
 * third leg the surface checks per request — on-chain revocation — is unit-tested in `packages/a2a`; killing
 * a wire live needs a UserOp from the agent's custodian, which this script does not drive.
 */
import { createPublicClient, http, encodeAbiParameters, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign as signRaw, generatePrivateKey } from 'viem/accounts';
import { hashDelegation, type Delegation } from '../packages/delegation/src/index.js';
import { skillSelector } from '../packages/a2a/src/grant.js';
import { wrapSessionSignature } from '../packages/a2a/src/session-wire.js';
import {
  STANDARD_SURFACE_SKILL, callerAssertionDigest, requestBodyHash, sessionAuthorizationHeader,
  type CallerAssertionV1,
} from '../packages/a2a/src/standard/caller.js';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const DM = '0x710cb1bF08C234Df397e0910331e0A29710EF4F7' as Address;
const TIMESTAMP = '0x73A7B878168b7DE48677617179A8bE894f0Dfe96';
const ALLOWED_METHODS = '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41';

const SVC = ((process.argv[2] ?? '0x309B2a566E93CC77aABe895d0eC2702c36856eBD').toLowerCase()) as Address;
const TARGET = process.argv[3] ?? 'alice.me';
const ENDPOINT = process.env.A2A_ENDPOINT ?? `https://edge.faithnet.io/api/a2a/${TARGET}`;
const AUDIENCE = process.env.A2A_AUDIENCE ?? new URL(ENDPOINT).origin;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const nowSec = () => Math.floor(Date.now() / 1000);

// ── Alice custodies the service agent; her key signs its wire (the SA's ERC-1271 accepts its custodian) ──
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error('no session for alice');
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const aliceEoa = (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === String(signin.agent).toLowerCase())!.custodian as Address;
const custodianSign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 200)}`);
  return b.signature;
};
const isCustodian = await pub.readContract({ address: SVC, abi: [{ type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }], functionName: 'isCustodian', args: [aliceEoa] });
console.log(`service agent ${SVC}\n  custodied by alice (${aliceEoa}): ${isCustodian ? '✓' : '✗'}\n  endpoint ${ENDPOINT}  audience ${AUDIENCE}`);
if (!isCustodian) throw new Error('alice does not custody this service agent — her key cannot mint its wire');

// ── THE SESSION WIRE: the service agent → a key the runtime holds, pinned to asking and nothing else ──
const RUNTIME_PK = generatePrivateKey();
const runtimeKey = privateKeyToAccount(RUNTIME_PK);

async function mintWire(skill: string, validUntil = nowSec() + 3600): Promise<{ wire: Record<string, unknown>; ref: Hex; delegation: Delegation }> {
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = {
    delegator: SVC, delegate: runtimeKey.address, authority: `0x${'0'.repeat(64)}` as Hex,
    caveats: [
      { enforcer: TIMESTAMP as Address, terms: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, BigInt(validUntil)]), args: '0x' },
      { enforcer: ALLOWED_METHODS as Address, terms: encodeAbiParameters([{ type: 'bytes4[]' }], [[skillSelector(skill)]]), args: '0x' },
    ],
    salt, signature: '0x',
  };
  const ref = hashDelegation(d, CHAIN, DM);
  d.signature = await custodianSign(ref);
  return { wire: { ...d, salt: salt.toString() }, ref, delegation: d };
}

const { wire, ref } = await mintWire(STANDARD_SURFACE_SKILL);
console.log(`session wire ${ref}\n  ${SVC} → ${runtimeKey.address}, pinned to "${STANDARD_SURFACE_SKILL}", 1 h`);

// ── A call, signed by the runtime's own key ──
const body = (text: string, method = 'SendMessage') => JSON.stringify({
  jsonrpc: '2.0', id: 1, method,
  params: { message: { messageId: `m-${crypto.randomUUID()}`, role: 'ROLE_USER', parts: [{ text }] } },
});

async function assertionFor(raw: string, w: Record<string, unknown> = wire, over: Partial<CallerAssertionV1> = {}): Promise<CallerAssertionV1> {
  const base = {
    agent: SVC, method: (JSON.parse(raw) as { method: string }).method, bodyHash: requestBodyHash(raw),
    issuedAt: nowSec(), audience: AUDIENCE, ...over,
  } as Omit<CallerAssertionV1, 'signature'>;
  const sig = await signRaw({ hash: callerAssertionDigest(base), privateKey: RUNTIME_PK, to: 'hex' });
  return { ...base, signature: wrapSessionSignature(w as never, sig) };
}

async function call(raw: string, a: CallerAssertionV1 | null, label: string): Promise<{ status: number; state?: string; said?: string; error?: string }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...(a ? { authorization: sessionAuthorizationHeader(a) } : {}) },
    body: raw,
  });
  const b = await j(res);
  const task = b.result?.task;
  const out = { status: res.status, state: task?.status?.state, said: task?.status?.message?.parts?.[0]?.text, error: b.error?.message };
  console.log(`  ${label.padEnd(34)} HTTP ${out.status} ${out.state ?? ''} ${JSON.stringify(out.said ?? out.error ?? '').slice(0, 120)}`);
  return out;
}

console.log('\n── the runtime asks, as itself ──');
const askRaw = body('what can you tell me');
const ok = await call(askRaw, await assertionFor(askRaw), 'wire-signed');
if (ok.status !== 200 || !ok.state) throw new Error(`the runtime was not admitted: ${JSON.stringify(ok)}`);

console.log('\n── negative twins ──');
const noAuthRaw = body('what can you tell me');
if ((await call(noAuthRaw, null, 'no credential')).status !== 401) throw new Error('an unauthenticated call must be 401');

const tamperRaw = body('send bob 500 usdc');
const forOther = await assertionFor(body('what can you tell me'));
if ((await call(tamperRaw, forOther, 'assertion for another body')).status !== 401) throw new Error('an assertion must bind its body');

const wrongSkill = await mintWire('messaging.deliver');
const skillRaw = body('what can you tell me');
if ((await call(skillRaw, await assertionFor(skillRaw, wrongSkill.wire), 'wire pinned to another skill')).status !== 401) throw new Error('a wire must pin the surface skill');

const replayRaw = body('what can you tell me');
const once = await assertionFor(replayRaw);
await call(replayRaw, once, 'first use');
if ((await call(replayRaw, once, 'replay of the same assertion')).status !== 401) throw new Error('an assertion must be single-use');

const staleRaw = body('what can you tell me');
if ((await call(staleRaw, await assertionFor(staleRaw, wire, { issuedAt: nowSec() - 900 }), 'stale assertion')).status !== 401) throw new Error('a stale assertion must be refused');

// THE WIRE'S OWN CLOCK. A wire is bounded whether or not anyone revokes it: past its window it authorizes
// nothing, and the runtime must come back to its custodian for another. Same fail-closed shape as a
// revocation, and unlike one it needs no chain write to demonstrate.
const lapsed = await mintWire(STANDARD_SURFACE_SKILL, nowSec() - 60);
const lapsedRaw = body('what can you tell me');
if ((await call(lapsedRaw, await assertionFor(lapsedRaw, lapsed.wire), 'wire past its window')).status !== 401) throw new Error('a lapsed wire must be refused');

console.log(`\n✓ spec 372 S3c: the runtime is admitted by its own agent's session wire and by nothing else — no credential, another body, another skill, a replay, a stale moment and a lapsed wire are each refused.`);
console.log(`  Revocation: the third leg the surface checks per request (\`isRevoked\` at ${DM}) is unit-tested in packages/a2a; revoking live needs a UserOp from the agent's custodian, which this script does not drive.`);
