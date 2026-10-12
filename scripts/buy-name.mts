/**
 * BUY A NAME ON A PRICED ROOT — the second half of a charter (ap-town spec 431).
 *
 *   npx tsx scripts/buy-name.mts --persona demo-admin --owner 0xBa73… --label people-groups --tld svc \
 *     [--payer 0x…] [--note demo/people-groups.faithnet.json] [--preview]
 *
 * `service.create` (and every other charter) DEPLOYS an agent and names nothing: on a priced root the
 * register call reverts, so the agent is born real and anonymous. The name is two further signed
 * operations, and this is `purchaseName` (apps/home/src/connect-client.ts) as a script — that function is
 * browser code (relative fetch, document cookies), so it cannot simply be imported here. What IS imported
 * is every call builder it uses: the package functions are pure and node-safe, which is why this is a port
 * and not a reimplementation. The two operations, in order:
 *
 *   1. THE PAYER (a treasury custodied by the same person) approves nothing and claims: the priced
 *      subregistry checks the ticket this Home's gate signed, pulls the fee in the estate's coin to the
 *      town's naming treasury, and registers the name to the OWNER.
 *   2. THE OWNER declares its derived type, presents the name as primary, and writes its records.
 *
 * `--preview` asks the gate for a price and a domain ruling and signs NOTHING (the route's own preview
 * mode). Run it first: the domain rule can refuse a label outright, and a refusal is cheaper to read than
 * to pay for. A bought name "never expires and is never resold" — there is no undo and no transfer.
 */
import { buildPricedClaimCalls, buildSetPrimaryNameCall, buildSetAddressAttributeCall, buildSetBytes32AttributeCall, buildSetStringAttributeCall, buildDeclareAgentTypeCalls, derivedTypeForTld, rootClassForDerivedType, namehash, priceOf, PREDICATE_ID, AGENT_KIND_ID, type ClaimTicketV1 } from '@agenticprimitives/agent-naming';
import { agentProfileResolverAbi } from '@agenticprimitives/agent-profile';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
/** The estate's app coin, the one names are bought with — never the funding stablecoin (lib/naming-price.ts). */
const COIN = { address: '0xa14E4a9447607c1233DcE34dB6Ead47C094f6141' as Address, decimals: 6 };

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PERSONA = arg('persona') ?? 'alice';
const OWNER = (arg('owner') ?? '').toLowerCase() as Address;
const LABEL = (arg('label') ?? '').trim().toLowerCase();
const TLD = (arg('tld') ?? 'svc').trim().toLowerCase();
const NOTE = arg('note');
const PREVIEW = process.argv.includes('--preview');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
if (!/^0x[0-9a-f]{40}$/.test(OWNER)) fail('--owner <0x…> is required (the agent the name is FOR)');
if (!/^[a-z0-9][a-z0-9-]*$/.test(LABEL)) fail('--label must be a name label');

const who = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: PERSONA, client_id: 'demo-web' }) }));
if (!who?.agent || !who?.homeSession) fail(`${PERSONA} could not sign in at ${HOME}: ${JSON.stringify(who).slice(0, 200)}`);
const ME = String(who.agent).toLowerCase() as Address;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };

/** THE PAYER: the person's own treasury, found among their recorded agents. Named explicitly, or discovered. */
const payerOf = async (): Promise<Address> => {
  const named = (arg('payer') ?? '').toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(named)) return named as Address;
  const rel = await j(await fetch(`${HOME}/connect/related-orgs`, { headers: { authorization: `Bearer ${who.homeSession}` } }));
  const t = (rel?.orgs ?? []).find((o: { purpose?: string }) => o.purpose === 'person-treasury');
  if (!t?.orgAgent) fail(`${PERSONA} has no person-treasury to pay from — pass --payer 0x…`);
  return String(t.orgAgent).toLowerCase() as Address;
};
const PAYER = await payerOf();

const pc = createPublicClient({ transport: http(RPC) });
const balance = (await pc.readContract({ address: COIN.address, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [PAYER] })) as bigint;
const price = priceOf(LABEL, TLD);
console.log(`── ${LABEL}.${TLD} ──`);
console.log(`  owner      ${OWNER}`);
console.log(`  payer      ${PAYER}  (${Number(balance) / 10 ** COIN.decimals} coins held)`);
console.log(`  price      ${price} — ${Number(balance) / 10 ** COIN.decimals >= price ? 'covered' : 'NOT COVERED'}`);

/** Ask this Home's naming gate for a ticket. A preview runs every check and signs nothing. */
const ticketFor = async (preview: boolean) => j(await fetch(`${HOME}/connect/naming-ticket`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.homeSession}` }, body: JSON.stringify({ label: LABEL, tld: TLD, owner: OWNER, payer: PAYER, ...(preview ? { preview: true } : {}) }) }));

const pv = await ticketFor(true);
if (pv?.ok !== true) fail(`the gate refused ${LABEL}.${TLD}: ${pv?.detail ?? pv?.error ?? JSON.stringify(pv).slice(0, 300)}${pv?.error === 'domain_protected' ? ` (the DOMAIN RULE: ${pv.domain} exists, so a verified email at that domain on this Home is required)` : ''}`);
console.log(`  gate       ticket available · subregistry ${pv.subregistry} · domain ${pv.domain ?? 'none claimed'}`);
if (PREVIEW) { console.log('\n--preview: the gate signed nothing and nothing was bought.'); process.exit(0); }

/** One batch, executed AS an agent: the Home builds the userOp, the persona signs it, the Home submits. */
const executeAs = async (sender: Address, calls: Array<{ to: Address; value: bigint; data: Hex }>, what: string, soft = false): Promise<Hex | undefined> => {
  if (!calls.length) return undefined;
  const callData = buildExecuteBatchCallData(calls);
  let last = 'execute failed';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2500));
    const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender, callData }) }));
    if (b?.ok !== true || !b.userOpHash || !b.userOp) { last = [b?.error, b?.detail].filter(Boolean).join(' — ') || `build failed (${b?._status ?? '?'})`; continue; }
    const s = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who.homeSession}` }, body: JSON.stringify({ digest: b.userOpHash }) }));
    if (!s?.signature) fail(`persona-sign refused the ${what} op: ${JSON.stringify(s).slice(0, 200)}`);
    const out = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: s.signature } }) }));
    if (out?.ok === true) { console.log(`  ${what} → tx ${String(out.transactionHash).slice(0, 18)}…`); return out.transactionHash as Hex; }
    last = [out?.error, out?.detail].filter(Boolean).join(' — ') || `submit failed (${out?._status ?? '?'})`;
  }
  // `soft` reports and carries on: a group that reverted is one thing missing, named, not the end of the run.
  if (soft) { console.log(`  ✗ ${what}: ${last}`); return undefined; }
  return fail(`${what}: ${last}`);
};

// ── 1. the payer claims ──
//
// ALREADY OWNED IS NOT A REASON TO PAY AGAIN. The registry's `owner(node)` is the one fact that says whether
// this name is bought; `resolveName` is NOT, because it reads the `addr` RECORD, which an unpresented name
// does not have yet. So a name bought-but-unpresented looked unregistered, the script re-ran the claim, and
// only the subregistry's own revert stopped a second 10 SHQ leaving the treasury (2026-10-12).
const nodeNow = namehash(`${LABEL}.${TLD}`) as Hex;
const owned = ((await pc.readContract({ address: CONTRACTS.agentNameRegistry as Address, abi: [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }], functionName: 'owner', args: [nodeNow] }).catch(() => '0x0000000000000000000000000000000000000000')) as Address).toLowerCase();
const isOwned = owned !== '0x0000000000000000000000000000000000000000';
if (isOwned && owned !== OWNER) fail(`${LABEL}.${TLD} is already owned by ${owned}, which is not the owner you named. A name is never resold.`);
if (isOwned) console.log(`  claim      skipped — already owned by ${OWNER}, nothing to pay`);
else {
const t = await ticketFor(false);
if (t?.ok !== true || !t.ticket || !t.signature) fail(`the gate would not sign a ticket: ${t?.detail ?? t?.error ?? JSON.stringify(t).slice(0, 300)}`);
const ticket: ClaimTicketV1 = { parentNode: t.ticket.parentNode as Hex, label: t.ticket.label, owner: t.ticket.owner as Address, payer: t.ticket.payer as Address, price: BigInt(t.ticket.price), domain: t.ticket.domain as Hex, expiry: BigInt(t.ticket.expiry), nonce: t.ticket.nonce as Hex };
console.log(`── the payer claims ${LABEL}.${TLD} ──`);
await executeAs(PAYER, buildPricedClaimCalls({ subregistry: t.subregistry as Address, coin: COIN.address, ticket, gateSignature: t.signature as Hex }) as never, 'paid and claimed');
}

// ── 2. the owner declares its type, presents the name and writes its records ──
const node = namehash(`${LABEL}.${TLD}`) as Hex;
const registered = (await pc.readContract({ address: CONTRACTS.agentProfileResolver as Address, abi: agentProfileResolverAbi, functionName: 'isRegistered', args: [OWNER] }).catch(() => false)) as boolean;
const derived = derivedTypeForTld(TLD);
const note = NOTE && existsSync(NOTE) ? (JSON.parse(readFileSync(resolvePath(NOTE), 'utf8')) as { service?: { facets?: Record<string, string> } }) : null;
const facets = note?.service?.facets ?? {};
const records: Array<{ label: string; call: { to: Address; value: bigint; data: Hex } }> = [
  { label: 'addr', call: buildSetAddressAttributeCall({ resolver: CONTRACTS.agentNameResolver as Address, node, predicate: PREDICATE_ID.addr, value: OWNER }) },
  { label: 'agentKind', call: buildSetBytes32AttributeCall({ resolver: CONTRACTS.agentNameResolver as Address, node, predicate: PREDICATE_ID.agentKind, value: AGENT_KIND_ID[rootClassForDerivedType(derived)] }) },
];
// THE RECORDS THE PLAN ALREADY CARRIES. `displayName` and `description` are the name's own (spec 430 N6a);
// the endpoint records are what makes the MCP reachable BY NAME rather than by a hostname a reader guessed.
for (const key of ['displayName', 'description', 'siteUrl', 'a2aEndpoint', 'mcpEndpoint'] as const) {
  const value = facets[key];
  const predicate = (PREDICATE_ID as Record<string, Hex>)[key];
  if (!value || !predicate) continue;
  records.push({ label: key, call: buildSetStringAttributeCall({ resolver: CONTRACTS.agentNameResolver as Address, node, predicate, value: value.slice(0, 280) }) });
}
// THREE OPS, NOT ONE BATCH. A batch reverts whole: one record whose predicate this estate's ontology
// registry has not activated takes the PRESENTATION down with it, and the name sits bought and unpresented
// with `userop_reverted` as the only explanation (seen 2026-10-12 buying people-groups.svc). Presenting the
// name is the part that must not be hostage to a record, so it goes first and alone, and each group says
// whether it landed. `set-service-facets.mts` solves the same problem by asking `isActive` per predicate;
// splitting the ops needs no registry read and tells you which group failed.
console.log(`── the owner presents ${LABEL}.${TLD} ──`);
const declare = buildDeclareAgentTypeCalls({ profileResolver: CONTRACTS.agentProfileResolver as Address, agent: OWNER, agentType: derived, serviceRole: TLD === 'svc' ? 'service' : undefined, registered }) as never as Array<{ to: Address; value: bigint; data: Hex }>;
const landed: Record<string, boolean> = {};
landed.presented = !!(await executeAs(OWNER, [buildSetPrimaryNameCall({ registry: CONTRACTS.agentNameRegistry as Address, node })], 'presented', true));
landed.typed = declare.length ? !!(await executeAs(OWNER, declare, 'declared its type', true)) : true;
// The records one at a time: an inactive predicate is then one missing record, not a missing name.
for (const r of records) landed[r.label] = !!(await executeAs(OWNER, [r.call], `record ${r.label}`, true));

const missing = Object.entries(landed).filter(([, ok]) => !ok).map(([k]) => k);
if (NOTE && existsSync(NOTE)) {
  const n = JSON.parse(readFileSync(resolvePath(NOTE), 'utf8')) as Record<string, unknown>;
  n.service = { ...(n.service as object), named: true, namedAt: new Date().toISOString(), presented: landed.presented === true, ...(missing.length ? { recordsNotWritten: missing } : {}) };
  writeFileSync(resolvePath(NOTE), JSON.stringify(n, null, 2) + '\n');
}
console.log(`\n✓ ${LABEL}.${TLD} → ${OWNER}, paid by ${PAYER}.`);
console.log(missing.length ? `  ✗ did not land: ${missing.join(', ')} — the name is bought and owned regardless.` : '  everything landed. The indexer projects it on its next pass.');
