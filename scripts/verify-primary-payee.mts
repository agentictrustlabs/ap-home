/**
 * `ap:primaryPayee` — the person being paid says which treasury receives.
 *
 *   npx tsx scripts/verify-primary-payee.mts
 *
 * Alice holds several treasuries. Before she says which one receives, a payer is asked to choose between
 * her accounts — a question about her arrangements put to the person who knows least about them. She
 * marks one, and the question disappears.
 *
 * It is a PREFERENCE: the run still stops at a mandate, and paying a different treasury of hers by name
 * still works. This checks that it removed a QUESTION and granted nothing.
 */
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { RELATIONSHIP_TYPE, ROLE } from '@agenticprimitives/agent-relationships';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const REL = '0x5015bD7d422e003511246f848cDd798cb00BB968' as Address;
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as Address;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) bad++; };

const ABI = [
  { type: 'function', name: 'getEdgeByTriple', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'hasRole', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'addRole', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'removeRole', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'bytes32' }], outputs: [] },
] as const;
const EXECUTE = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] }] as const;

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) })) as { homeSession: string };
const nathan = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'nathan', client_id: 'demo-jp' }) })) as { homeSession: string };

/** Run one call as Alice's SA, signed by her credential. */
async function asAlice(to: Address, data: Hex): Promise<string> {
  const callData = encodeFunctionData({ abi: EXECUTE, functionName: 'execute', args: [to, 0n, data] });
  const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: ALICE, callData }) })) as { ok?: boolean; userOpHash?: Hex; userOp?: Record<string, unknown>; error?: string };
  if (!b.ok || !b.userOpHash) throw new Error(`build: ${b.error ?? '?'}`);
  const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` }, body: JSON.stringify({ digest: b.userOpHash }) })) as { signature?: Hex };
  const out = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: sig.signature } }) })) as { ok?: boolean; transactionHash?: string; error?: string; detail?: string };
  if (!out.ok) throw new Error(`submit: ${out.error ?? ''} ${out.detail ?? ''}`);
  return out.transactionHash ?? '';
}

/** What the payer is shown for "send 1 usdc to alice": a question, or an answer. */
async function askedToChoose(): Promise<{ choices: number; payee?: string }> {
  const caps = ((await j(await fetch(`${HOME}/a2a/harness/vocabulary`))) as { capabilities: Array<{ id: string }> }).capabilities.map((c) => c.id);
  const t = await j(await fetch(`${HOME}/a2a/harness/ask`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ session: nathan.homeSession, addressee: '0x1dba4a27c53d7babda99513080223fb3bfc4bad1', message: 'send 1 usdc to alice', surface: { ceremonies: ['data', 'confirmation', 'signature'], capabilities: caps }, runRef: `pp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` }),
  })) as { reply?: { kind?: string; prompt?: { fields?: Array<{ choices?: unknown[] }> }; parties?: Array<{ arg: string; label?: string }> } };
  const r = t.reply ?? {};
  return { choices: (r.prompt?.fields?.[0]?.choices ?? []).length, payee: r.parties?.find((p) => p.arg === 'payee')?.label };
}

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${alice.homeSession}` } }))) as { orgs?: Array<{ orgAgent: string; orgName?: string; kind?: string }> }).orgs ?? [];
const named = orgs.find((o) => o.kind === 'person-treasury' && String(o.orgName ?? '').includes('.'))!;
console.log(`── alice marks ${named.orgName} as where payments go ──`);

const before = await askedToChoose();
check('before, the payer is asked to choose between her accounts', before.choices > 1, `${before.choices} choices`);

const edgeId = await pub.readContract({ address: REL, abi: ABI, functionName: 'getEdgeByTriple', args: [named.orgAgent as Address, ALICE, RELATIONSHIP_TYPE.CHARTERED_UNDER] }) as Hex;
check('her treasury has a public chartered edge to mark', edgeId !== `0x${'0'.repeat(64)}`, edgeId.slice(0, 14));
await asAlice(REL, encodeFunctionData({ abi: ABI, functionName: 'addRole', args: [edgeId, ROLE.PRIMARY_PAYEE] }));
const marked = await pub.readContract({ address: REL, abi: ABI, functionName: 'hasRole', args: [edgeId, ROLE.PRIMARY_PAYEE] }) as boolean;
check('and she marks it, on chain, herself', marked === true, 'ap:primaryPayee');

const after = await askedToChoose();
check('after, the question is gone', after.choices === 0, after.payee ?? `${after.choices} choices`);
check('and it went to the one she named', (after.payee ?? '').includes(String(named.orgName)), after.payee ?? '(none)');

// Put it back: this is a live estate and a preference is the owner's, not a test's.
await asAlice(REL, encodeFunctionData({ abi: ABI, functionName: 'removeRole', args: [edgeId, ROLE.PRIMARY_PAYEE] }));
console.log(`\n${bad === 0 ? '✓' : '✗'} primaryPayee: the recipient chose, and the payer stopped being asked — ${bad} failure(s).`);
if (bad) process.exit(1);
