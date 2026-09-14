/**
 * Spec 400 W1b — PAIR A RUNTIME with a code the custodian minted at her Home.
 *
 *   npx tsx scripts/verify-runtime-pair.mts        (from the repo root; fixture role `acpRuntime`)
 *
 * What the Home's "Pair a runtime" screen does, played from both sides:
 *   1. the steward MINTS a code on her own agent (`runtime.pairing.mint`) — what the runtime will get, chosen once;
 *   2. the runtime, holding NOTHING but the code and the Home's URL, runs `ap runtime pair`: generates its key here,
 *      claims the code through the Home (`/connect/runtime-pair/claim`) and waits;
 *   3. the steward sees the claim (`runtime.pairing.list` → state `claimed`, the key, the agent) and APPROVES — her
 *      browser equips the member for THAT key (every signature hers) and hands the record through the code;
 *   4. the runtime takes the record ONCE, keeps it with its key, and speaks as the member: reads its own inbox.
 * Twins: a second key cannot claim the code; the record cannot be taken twice; a code the steward cancelled is
 * unknown to the runtime.
 *
 * The approve step here uses the persona custodian the way the browser uses the connected credential (the same
 * `equipRuntimeMember`); the Home's screen itself is a UI over the same three ops.
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address } from 'viem';
import { runtimePair, personaCustodian, askAs } from '@agenticprimitives/runtime-member';
import { equipRuntimeMember } from '@agenticprimitives/runtime-member/equip';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.acpRuntime, 'ACP runtime member (acpRuntime: its .svc and workspace)');
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
process.env.AP_RUNTIME_DIR ??= `/tmp/ap-runtime-pair-${process.pid}`;

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const fail = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };
const steward = await personaCustodian(HOME, fx.people.steward);
const me = steward.agent.toLowerCase() as Address;
const op = (n: string, b: Record<string, unknown>) => fetch(`${A2A}/interactions/${me}/runtime.pairing.${n}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: steward.bearer, ...b }) }).then(j);
console.log(`── ${fx.people.steward} ${me} pairs ${R.member} into ${R.workspace} ──`);

// ── 1. mint ──
const minted = await op('mint', { handle: fx.people.steward, options: { member: R.member, workspace: R.workspace, validForSeconds: 3600, openMandate: [], messagingTo: [me], wake: 'poll' } });
if (minted.ok !== true) fail(`mint: ${JSON.stringify(minted).slice(0, 200)}`);
const code: string = minted.pairing.code;
console.log(`  minted ${code} (expires ${minted.pairing.expiresAt})`);

// ── 2. the runtime pairs — nothing but the code and the Home ──
const runtimeSide = runtimePair({ home: HOME, code, agent: 'acp-stub-agent', pollMs: 2000, log: (l) => console.log(`  runtime: ${l}`) });
// wait for the claim to show on the steward's side
let claimed: { claim: { address: string; agent?: string } } | null = null;
for (let i = 0; i < 20 && !claimed; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const l = await op('list', {});
  const p = (l.pairings ?? []).find((x: { code: string; state: string }) => x.code === code);
  if (p?.state === 'claimed') claimed = p;
}
if (!claimed) fail('the runtime\'s claim never reached the steward\'s list');
console.log(`  steward sees: claimed by key ${claimed!.claim.address} running ${claimed!.claim.agent}`);

// twin — a second key cannot claim
const other = await j(await fetch(`${HOME}/connect/runtime-pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, address: privateKeyToAccount(generatePrivateKey()).address }) }));
if (other.ok !== false || !/another key/.test(String(other.error))) fail(`twin: a second key claimed the code: ${JSON.stringify(other).slice(0, 200)}`);
console.log('  twin: a second key is refused ✓');

// ── 3. approve — equip for THAT key, every signature the custodian's, then hand it through the code ──
const record = await equipRuntimeMember({ home: HOME, edge: fx.edge, a2a: A2A, member: R.member, workspace: R.workspace, contracts: C as never, custodian: steward, address: claimed!.claim.address as Address, registry: { origin: fx.skillsRegistry, context: 'agentic-trust', archetype: 'runtime-member' }, validForSeconds: 3600, messagingTo: [me], log: (l) => console.log(`  approve: ${l}`) });
const done = await op('complete', { code, record });
if (done.ok !== true) fail(`complete: ${JSON.stringify(done).slice(0, 200)}`);
console.log('  approved — the record is on the code');

// ── 4. the runtime takes it and speaks as the member ──
const { record: taken, path } = await runtimeSide;
if (taken.address.toLowerCase() !== claimed!.claim.address.toLowerCase() || !taken.key) fail('the runtime kept a record for another key');
console.log(`  runtime kept ${path}`);
const inbox = await askAs(taken, taken.name, "what's new for me", { plan: { steps: [{ toolId: 'messaging.inbox.list', args: { limit: 1 } }] } });
if (inbox.state !== 'TASK_STATE_COMPLETED') fail(`the paired runtime could not read its own inbox as itself: ${JSON.stringify(inbox).slice(0, 300)}`);
console.log(`  the paired runtime reads its own inbox as ${taken.name} ✓`);

// twins — taken once; a cancelled code is unknown
const again = await j(await fetch(`${HOME}/connect/runtime-pair/take`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, address: taken.address }) }));
if (again.ok !== false) fail(`twin: the record was taken twice: ${JSON.stringify(again).slice(0, 200)}`);
const spare = await op('mint', { handle: fx.people.steward, options: { member: R.member, workspace: R.workspace, wake: 'poll' } });
await op('cancel', { code: spare.pairing.code });
const gone = await j(await fetch(`${HOME}/connect/runtime-pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: spare.pairing.code, address: taken.address }) }));
if (gone.ok !== false) fail(`twin: a cancelled code was claimed: ${JSON.stringify(gone).slice(0, 200)}`);
console.log('  twins: taken once, a cancelled code is unknown ✓');
console.log('✓ verify-runtime-pair — a runtime joined with a code the custodian minted at her Home; every grant hers');
