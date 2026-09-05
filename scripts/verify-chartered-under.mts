/**
 * Spec 355 W2 — the ownership edge is PUBLIC, and that is what makes a stranger able to pay you.
 *
 *   npx tsx scripts/verify-chartered-under.mts
 *
 * The link between alice.me and alice2.treasury was true and unreadable: it lived in Alice's own vault
 * (ADR-0025), so "send alice 20 USDC" could be routed by Alice and by nobody else. Recording it as an
 * `ap:charteredUnder` edge both parties signed makes it a chain-reproducible fact (ADR-0040).
 *
 * A pass proves the edge is on chain and ACTIVE, that NATHAN — who can read nothing of Alice's — is
 * routed by it, and that it still grants nothing: the payment reaches a mandate request, not a payment.
 */
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { RELATIONSHIP_TYPE } from '../packages/agent-relationships/src/constants.js';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const REL = '0x5015bD7d422e003511246f848cDd798cb00BB968' as Address;
const ALICE = '0xb0d11ce19b756a682e78b4904cd8d832303b3d11' as Address;
const ALICE2 = '0x5ef5360a41f31e55541117a854455c0da0fb67b3';

const pub = createPublicClient({ transport: http(RPC) });
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`  ${ok ? '✓' : '✗'} ${label} — ${detail}`); if (!ok) bad++; };

const ABI = [
  { type: 'function', name: 'getEdgesByObject', stateMutability: 'view', inputs: [{ name: 'object_', type: 'address' }], outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'getEdge', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [
    { type: 'tuple', components: [
      { name: 'edgeId', type: 'bytes32' }, { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' },
      { name: 'relationshipType', type: 'bytes32' }, { name: 'status', type: 'uint8' }, { name: 'createdBy', type: 'address' },
      { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' },
      { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' },
    ] }] },
] as const;

console.log('── the edge, on chain ──');
const ids = await pub.readContract({ address: REL, abi: ABI, functionName: 'getEdgesByObject', args: [ALICE] }) as Hex[];
const edges = await Promise.all(ids.map((id) => pub.readContract({ address: REL, abi: ABI, functionName: 'getEdge', args: [id] })));
const chartered = (edges as Array<{ subject: string; relationshipType: string; status: number }>)
  .filter((e) => e.relationshipType.toLowerCase() === RELATIONSHIP_TYPE.CHARTERED_UNDER.toLowerCase() && Number(e.status) === 3);
check('alice has ACTIVE charteredUnder edges', chartered.length > 0, `${chartered.length} edge(s): ${chartered.map((e) => e.subject.slice(0, 10)).join(', ')}`);
check('her treasury is one of them', chartered.some((e) => e.subject.toLowerCase() === ALICE2), ALICE2);

console.log('\n── a stranger is routed by it ──');
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'nathan', client_id: 'demo-jp' }) })) as { homeSession?: string; agent?: string };
const caps = ((await j(await fetch(`${HOME}/a2a/harness/vocabulary`))) as { capabilities: Array<{ id: string }> }).capabilities.map((c) => c.id);
const surface = { ceremonies: ['data', 'confirmation', 'signature'], capabilities: caps };
const runRef = `w2-${Date.now().toString(36)}`;
const ask = async (body: Record<string, unknown>) =>
  ((await j(await fetch(`${HOME}/a2a/harness/ask`, { method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' }, body: JSON.stringify(body) }))) as { reply?: Record<string, never> }).reply ?? {};

const t1 = await ask({ session: s.homeSession, addressee: s.agent, message: 'send 10 usdc to alice', surface, runRef }) as
  { kind?: string; prompt?: { resumeToken?: string; fields?: Array<{ choices?: Array<{ value: string; label: string }> }> }; parties?: Array<{ arg: string; label?: string }> };
const choices = t1.prompt?.fields?.[0]?.choices ?? [];
// Nathan holds no record of Alice's agents. If her treasuries are offered, the chain is where they came from.
check('nathan is offered alice’s treasuries', choices.some((c) => c.value.toLowerCase() === ALICE2), choices.map((c) => c.label).join(', ') || t1.kind || 'nothing offered');

console.log('\n── and it still grants nothing ──');
const t2 = await ask({ session: s.homeSession, addressee: s.agent, surface, runRef, supplied: [{ stepRef: 's0', data: { payee: ALICE2 } }] }) as
  { kind?: string; capability?: string; parties?: Array<{ arg: string; label?: string }> };
check('the payment reaches a MANDATE REQUEST, not a payment', t2.kind === 'authority_required', `${t2.kind} ${t2.capability ?? ''}`);
for (const p of t2.parties ?? []) console.log(`     ${p.arg}: ${p.label ?? '(address)'}`);

console.log(`\n${bad === 0 ? '✓' : '✗'} W2: the ownership edge is on chain, public, routable by a stranger, and grants nothing — ${bad} failure(s).`);
if (bad) process.exit(1);
