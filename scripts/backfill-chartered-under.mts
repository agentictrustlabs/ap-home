/**
 * Spec 355 W2 — record `ap:charteredUnder` on chain for the agents that already exist.
 *
 *   npx tsx scripts/backfill-chartered-under.mts [--dry] [--handles alice,nathan] [--kinds treasury]
 *
 * WHY. The edge is TRUE of alice and alice2.treasury and was readable only by Alice: it lived in her own
 * vault (ADR-0025), so nobody else could be routed to her treasury and "send alice 20 USDC" dead-ended.
 * An edge minted on chain is exactly the public, chain-reproducible fact ADR-0040 admits, so recording it
 * makes the relationship traversable by anyone without exposing anything the chain does not already say.
 *
 * WHAT IT DOES NOT DO. It grants nothing. `charteredUnder` is belonging, never authority — the child
 * holds its own custody, and what lets a parent act for it is a delegation. Backfilling every edge in the
 * estate changes no one's ability to spend anything.
 *
 * HOW. Each edge is three calls, and the contract decides who may make each: the SUBJECT proposes, the
 * OBJECT confirms, either activates. For a personal treasury one person custodies both sides, so all
 * three are signable by the same demo persona — which is exactly why this is safe to run here and would
 * be a multi-party ceremony in production.
 */
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { RELATIONSHIP_TYPE } from '@agenticprimitives/agent-relationships';

const HOME = process.env.HOME_BASE ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
const REL = (process.env.AGENT_RELATIONSHIP ?? '0x5015bD7d422e003511246f848cDd798cb00BB968') as Address;
const DRY = process.argv.includes('--dry');
const argOf = (flag: string): string[] => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const HANDLES = argOf('--handles').length ? argOf('--handles') : ['alice', 'nathan'];
/** Which child kinds to record. Treasuries first: they are what payment routing needs. */
const KINDS = new Set(argOf('--kinds').length ? argOf('--kinds') : ['person-treasury', 'org-treasury']);

const REL_ABI = [
  { type: 'function', name: 'proposeEdge', stateMutability: 'nonpayable', inputs: [
    { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' },
    { name: 'relationshipType', type: 'bytes32' }, { name: 'initialRoles', type: 'bytes32[]' },
    { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' },
  ], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'confirmEdge', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'activateEdge', stateMutability: 'nonpayable', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'getEdgeByTriple', stateMutability: 'view', inputs: [
    { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' }, { name: 'relationshipType', type: 'bytes32' },
  ], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'getEdge', stateMutability: 'view', inputs: [{ name: 'edgeId', type: 'bytes32' }], outputs: [
    { type: 'tuple', components: [
      { name: 'edgeId', type: 'bytes32' }, { name: 'subject', type: 'address' }, { name: 'object_', type: 'address' },
      { name: 'relationshipType', type: 'bytes32' }, { name: 'status', type: 'uint8' }, { name: 'createdBy', type: 'address' },
      { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' },
      { name: 'metadataURI', type: 'string' }, { name: 'metadataHash', type: 'bytes32' },
    ] },
  ] },
] as const;
/** ERC-4337 account `execute(to,value,data)` — the SA makes the call, so msg.sender is the agent. */
const EXECUTE_ABI = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] , outputs: [] }] as const;

const pub = createPublicClient({ transport: http(RPC) });
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
const H = { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf.token ?? '' };

/** Run one call AS `sender`, signed by the persona whose session this is. */
async function executeAs(sender: Address, to: Address, data: Hex, token: string): Promise<string> {
  const callData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [to, 0n, data] });
  for (let attempt = 0; attempt < 4; attempt++) {
    const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender, callData }) })) as
      { ok?: boolean; userOpHash?: Hex; userOp?: Record<string, unknown>; error?: string; detail?: string };
    if (!b.ok || !b.userOpHash || !b.userOp) { if (attempt === 3) throw new Error(`build: ${b.error ?? ''} ${b.detail ?? ''}`); continue; }
    const sig = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest: b.userOpHash }) })) as { signature?: Hex; error?: string };
    if (!sig.signature) throw new Error(`persona-sign refused: ${sig.error ?? 'no signature'}`);
    const out = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: sig.signature } }) })) as
      { ok?: boolean; transactionHash?: string; error?: string; detail?: string };
    if (out.ok) return out.transactionHash ?? '(no tx hash)';
    // A nonce collision is the one worth retrying: two ops from the same sender race on the EntryPoint.
    if (attempt === 3 || !/nonce|AA25|replacement/i.test(`${out.error ?? ''}${out.detail ?? ''}`)) throw new Error(`submit: ${out.error ?? ''} ${out.detail ?? ''}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('unreachable');
}

const STATUS = ['NONE', 'PROPOSED', 'CONFIRMED', 'ACTIVE', 'REVOKED'];
let recorded = 0, already = 0, failed = 0;

for (const handle of HANDLES) {
  const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) })) as { homeSession?: string; agent?: string };
  if (!signin.homeSession || !signin.agent) { console.error(`✗ ${handle}: no session`); failed++; continue; }
  const token = signin.homeSession;
  const tree = await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${token}` } })) as { orgs?: Array<{ orgAgent: string; orgName: string; kind?: string; parent?: string }> };
  // NAMELESS AGENTS ARE LEFT OFF THE CHAIN, deliberately (spec 338 / ADR-0056). An unnamed agent is one
  // its owner chose not to publish; recording "alice holds a treasury at 0x…" would put back exactly the
  // fact the missing name withholds, and the owner never asked for that. Discovering an unlisted agent is
  // a GRANT its owner issues to one recipient, not a side effect of a backfill.
  const all = (tree.orgs ?? []).filter((o) => KINDS.has(String(o.kind ?? '')) && !!o.parent);
  const unnamed = all.filter((o) => !String(o.orgName ?? '').includes('.'));
  const children = all.filter((o) => String(o.orgName ?? '').includes('.'));
  for (const o of unnamed) console.log(`  · ${o.orgAgent.slice(0, 10)}… skipped — unnamed, so unlisted by choice`);
  console.log(`\n── ${handle} (${signin.agent}) — ${children.length} child agent(s) to record ──`);

  for (const child of children) {
    // charteredUnder: the CHILD is the subject, the parent is the object.
    const subject = child.orgAgent.toLowerCase() as Address;
    const object = child.parent!.toLowerCase() as Address;
    const label = `${child.orgName} → ${object.slice(0, 10)}…`;
    const existing = await pub.readContract({ address: REL, abi: REL_ABI, functionName: 'getEdgeByTriple', args: [subject, object, RELATIONSHIP_TYPE.CHARTERED_UNDER] }).catch(() => null) as Hex | null;
    let edgeId = existing && existing !== `0x${'0'.repeat(64)}` ? existing : null;
    let status = 0;
    if (edgeId) {
      const e = await pub.readContract({ address: REL, abi: REL_ABI, functionName: 'getEdge', args: [edgeId] }) as { status: number };
      status = Number(e.status);
      if (status === 3) { console.log(`  ✓ ${label} — already ACTIVE`); already++; continue; }
      console.log(`  … ${label} — exists at ${STATUS[status]}, continuing the lifecycle`);
    }
    if (DRY) { console.log(`  (dry) would record ${label}`); continue; }
    try {
      if (!edgeId) {
        // The SUBJECT proposes: the treasury says whom it belongs to.
        const data = encodeFunctionData({ abi: REL_ABI, functionName: 'proposeEdge', args: [subject, object, RELATIONSHIP_TYPE.CHARTERED_UNDER, [], '', `0x${'0'.repeat(64)}`] });
        console.log(`    propose  ${await executeAs(subject, REL, data, token)}`);
        edgeId = await pub.readContract({ address: REL, abi: REL_ABI, functionName: 'getEdgeByTriple', args: [subject, object, RELATIONSHIP_TYPE.CHARTERED_UNDER] }) as Hex;
        status = 1;
      }
      if (status === 1) {
        // The OBJECT confirms: the person agrees it is theirs. Both sides say so, or there is no edge.
        const data = encodeFunctionData({ abi: REL_ABI, functionName: 'confirmEdge', args: [edgeId] });
        console.log(`    confirm  ${await executeAs(object, REL, data, token)}`);
        status = 2;
      }
      if (status === 2) {
        const data = encodeFunctionData({ abi: REL_ABI, functionName: 'activateEdge', args: [edgeId] });
        console.log(`    activate ${await executeAs(object, REL, data, token)}`);
      }
      console.log(`  ✓ ${label} — ACTIVE (${edgeId.slice(0, 12)}…)`);
      recorded++;
    } catch (e) {
      console.error(`  ✗ ${label} — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
}

console.log(`\n${failed ? '✗' : '✓'} charteredUnder backfill: ${recorded} recorded, ${already} already active, ${failed} failed.`);
if (failed) process.exit(1);
