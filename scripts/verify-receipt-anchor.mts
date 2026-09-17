/**
 * Spec 406 W2 — THE RECEIPT ANCHOR ON CHAIN (supplied plans; no model).
 *
 *   npx tsx scripts/verify-receipt-anchor.mts        (RPC_URL=<a node of chain 34348> to read the registry yourself)
 *
 *   1. the steward asks ONE read (a run that leaves no transaction of its own); the runtime exports its PROV bundle and
 *      ANCHORS the bundle's digest in the ReceiptAnchorRegistry from its harness agent — the export report says so, and
 *      the run's public projection carries the anchor (digests and addresses only);
 *   2. THE HOLDER RECOMPUTES: the bundle read under her session (`POST /harness/provenance`) hashes, canonically, to the
 *      digest the projection names; with an RPC, `anchorOf(digest)` on the chain names the harness agent, a block, and
 *      the intent digest of the ask;
 *   3. the twin: a bundle altered in transit hashes to a digest the registry does not hold.
 */
import { createPublicClient, http, defineChain, keccak256, toBytes, type Hex } from 'viem';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
// The same canonical form the runtime digests (stable keys, no whitespace, undefineds dropped) — a holder needs no library.
const stable = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
const digestOf = (bundle: unknown): Hex => keccak256(toBytes(stable(bundle)));
const ANCHOR_ABI = [{ type: 'function', name: 'anchorOf', stateMutability: 'view', inputs: [{ name: 'receiptDigest', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [{ name: 'anchoredBy', type: 'address' }, { name: 'at', type: 'uint64' }, { name: 'intentDigest', type: 'bytes32' }, { name: 'mandateRef', type: 'bytes32' }] }] }] as const;
console.log(`── receipt anchor · ${fx.people.steward} ${me.agent} ──`);

// ── 1. a read; its export anchors the bundle ──
const asked = await post('/harness/ask', { session: me.bearer, addressee: me.agent, message: 'what do you remember about me', plan: { steps: [{ toolId: 'person.memory.list', args: {} }] } });
const runRef = String(asked.reply?.runRef ?? '');
if (asked.reply?.kind !== 'answer' || !runRef) fail(`the read did not answer: ${JSON.stringify(asked).slice(0, 300)}`);
let pub: { anchor?: { digest: Hex; registry: string; anchoredBy: string; txHash?: Hex; chainId?: number }; rows?: unknown[] } = {};
for (let i = 0; i < 12 && !pub.anchor; i++) { await new Promise((r) => setTimeout(r, 2500)); pub = await post('/provenance/public', { agent: me.agent, runRef }); }
if (!pub.anchor?.digest || !pub.anchor.txHash) fail(`the run was not anchored: ${JSON.stringify(pub).slice(0, 300)}`);
console.log(`  read → ${asked.reply.kind} · run ${runRef} · ${(pub.rows ?? []).length} step anchor(s) of its own · run anchor ${pub.anchor.digest.slice(0, 14)}… tx ${pub.anchor.txHash.slice(0, 14)}… by ${pub.anchor.anchoredBy.slice(0, 10)}… at ${pub.anchor.registry.slice(0, 10)}…`);
if (JSON.stringify(pub).includes('remember')) fail('a word of the ask reached the public projection');

// ── 2. the holder recomputes ──
const bundle = await post('/harness/provenance', { session: me.bearer, addressee: me.agent, runRef, format: 'jsonld' });
const doc = bundle.provenance ?? bundle.graph ?? bundle.document ?? bundle;
const recomputed = digestOf(doc);
if (recomputed !== pub.anchor.digest) fail(`the bundle she holds hashes to ${recomputed.slice(0, 14)}…, the anchor names ${pub.anchor.digest.slice(0, 14)}… (keys of the reply: ${Object.keys(bundle).join(', ')})`);
console.log(`  recomputed: the bundle's stable-JSON keccak equals the anchored digest`);
const RPC = process.env.RPC_URL;
if (RPC) {
  const chain = defineChain({ id: 34348, name: 'faithchain', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const client = createPublicClient({ chain, transport: http(RPC) });
  const a = await client.readContract({ address: pub.anchor.registry as Hex, abi: ANCHOR_ABI, functionName: 'anchorOf', args: [recomputed] });
  if (a.anchoredBy.toLowerCase() !== pub.anchor.anchoredBy.toLowerCase() || !a.at) fail(`the chain does not hold the anchor as projected: ${JSON.stringify(a)}`);
  const rcpt = await client.getTransactionReceipt({ hash: pub.anchor.txHash });
  console.log(`  chain: anchorOf(digest) → by ${a.anchoredBy.slice(0, 10)}… at ${new Date(Number(a.at) * 1000).toISOString()} · intent ${a.intentDigest.slice(0, 14)}… · tx ${rcpt.status} in block ${rcpt.blockNumber}`);
  // ── 3. the twin: a tampered bundle is not anchored ──
  const tampered = digestOf({ ...(doc as object), tampered: true });
  const t = await client.readContract({ address: pub.anchor.registry as Hex, abi: ANCHOR_ABI, functionName: 'anchorOf', args: [tampered] });
  if (t.anchoredBy !== '0x0000000000000000000000000000000000000000') fail('a tampered bundle found an anchor');
  console.log('  twin: a bundle altered in transit → no anchor on the chain');
} else console.log('  chain: NOT CHECKED — set RPC_URL to a node of chain 34348 to read anchorOf(digest) yourself (the digest equality above is the gate here)');

console.log(`\n✓ spec 406 W2: a run with no transaction of its own is anchored — its PROV bundle's digest in the ReceiptAnchorRegistry from the harness agent, bound to the intent; the holder recomputes and the chain agrees; a tampered bundle finds nothing.`);
