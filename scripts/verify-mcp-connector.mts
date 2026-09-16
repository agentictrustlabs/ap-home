/**
 * Spec 404 — AN EXTERNAL MCP SERVER AS A CONNECTOR, under the holder's mandate (supplied plans; no model).
 *
 *   npx tsx scripts/verify-mcp-connector.mts        (FIXTURE_JSON=… for another estate; MCP_SERVER_URL=… for another server)
 *
 * The steward, at her own agent:
 *   1. ATTACHES a server (Ligonier's catalog MCP — a stranger's server on another account): the runtime probes it and
 *      compiles its tools; none is annotated read-only ⇒ every one is an ACT at risk high under her mandate;
 *   2. TWIN — calls `search_resources`: the run parks for HER authority (the server's own credential authorizes nothing;
 *      the server is never called without the mandate); she signs; the call runs; what came back is UNTRUSTED evidence,
 *      the reply carries the McpToolCard binding, and no token shape appears anywhere;
 *   3. re-attaches DECLARING `search_resources` a read ⇒ the same call answers under her standing, no signature asked;
 *   4. `mcp.connectors.list` names the server and each tool's kind and why; the record is hers (`connector.mcp:<id>`);
 *   5. REMOVES it ⇒ the tool is gone on the next ask (refused as removed, never guessed).
 * What it does not claim: that the server's answers are true (evidence, never instructions).
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME } from './fixture.mts';

const SERVER = process.env.MCP_SERVER_URL ?? 'https://gc-ligonier-catalog.r-pedersen.workers.dev/mcp';
const C = ((await import(`@agenticprimitives/contracts/deployments/${process.env.CHAIN_NAME ?? 'faithchain'}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const me = await personaCustodian(HOME, fx.people.steward);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify({ session: me.bearer, ...(body as object) }) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; resumeToken?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; prompt?: { kind?: string; stepRef?: string; digest?: Hex; signer?: string }; result?: unknown; results?: Array<{ toolId: string; result: unknown }>; interaction?: { result?: string }; capability?: string };
const resultOf = (rep: Reply, toolId: string) => ((rep.results ?? []).find((x) => x.toolId === toolId)?.result ?? rep.result ?? {}) as Record<string, unknown>;
const TOKEN_RE = /(gh[posr]_[A-Za-z0-9]{10,}|xai-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{16,})/;

async function approveAndContinue(rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve: ${JSON.stringify(rep).slice(0, 200)}`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement!, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement!.intentDigest as Hex)];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
  const b2 = await post('/harness/authorize', { delegator: rep.delegator, userOp: a.userOp, signature: await me.signDigest(a.userOpHash as Hex) });
  if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
  mandate.signature = '0x03';
  let r = (await post('/harness/ask', { addressee: me.agent, runRef: rep.runRef, presented: { ...mandate, salt: salt.toString() } })).reply as Reply;
  if (r.kind === 'prompt' && r.prompt?.kind === 'signature' && r.prompt.digest) {
    const p = r.prompt;
    r = (await post('/harness/ask', { addressee: me.agent, runRef: r.runRef, supplied: [{ stepRef: r.resumeToken ?? p.stepRef, signature: { digest: p.digest, signer: p.signer ?? me.agent, signature: await me.signDigest(p.digest) } }] })).reply as Reply;
  }
  return r;
}
const connectors = async (body: Record<string, unknown>) => post('/harness/connectors/mcp', body);
console.log(`── mcp connector · ${SERVER} · ${fx.people.steward} ${me.agent} ──`);

// ── 1. attach: a stranger's server, its tools compiled — none annotated ⇒ all acts ──
const attached = await connectors({ op: 'attach', name: 'Ligonier catalog', url: SERVER });
if (attached.ok !== true) fail(`attach failed: ${JSON.stringify(attached).slice(0, 300)}`);
const conn = attached.connector as { id: string; name: string; server: { name: string | null }; tools: Array<{ name: string; kind: string; why: string; capability: string }> };
const search = conn.tools.find((t) => t.name === 'search_resources');
if (!search || search.kind !== 'act' || search.why !== 'default') fail(`search_resources was not compiled as an act by default: ${JSON.stringify(conn.tools).slice(0, 300)}`);
console.log(`  attached ${conn.name} (${conn.server.name}) · ${conn.tools.length} tools, all acts by default (no readOnlyHint): ${conn.tools.map((t) => t.name).join(', ')}`);

// ── 2. the twin, then the act under her mandate ──
const parked = (await post('/harness/ask', { addressee: me.agent, message: 'search on Ligonier catalog for justification', plan: { steps: [{ toolId: search.capability, args: { q: 'justification', holder: me.agent } }] } })).reply as Reply;
if (parked.kind !== 'authority_required') fail(`an act on the connector did not park for her authority: ${JSON.stringify(parked).slice(0, 300)}`);
if (parked.delegator?.toLowerCase() !== me.agent.toLowerCase()) fail(`the mandate asked is ${parked.delegator}'s, not the holder's`);
console.log(`  twin: ${search.capability} → authority_required (HER mandate; the server's credential authorizes nothing; not called)`);
const done = await approveAndContinue(parked);
if (done.kind !== 'done' && done.kind !== 'answer') fail(`the act did not complete under her mandate: ${JSON.stringify(done).slice(0, 400)}`);
const out = resultOf(done, search.capability) as { called?: boolean; untrusted?: boolean; kind?: string; text?: string; note?: string };
if (!out.called || out.untrusted !== true || out.kind !== 'act') fail(`the call did not return untrusted evidence: ${JSON.stringify(out).slice(0, 300)}`);
if (done.interaction?.result && done.interaction.result !== 'McpToolCard') fail(`the reply's result binding is ${done.interaction.result}, not McpToolCard`);
if (TOKEN_RE.test(JSON.stringify(done))) fail('a credential shape appeared in the reply');
console.log(`  signed → called: ${(out.text ?? '').slice(0, 90).replace(/\s+/g, ' ')}… · untrusted evidence · binding ${done.interaction?.result ?? '(none)'}`);

// ── 3. declared a read ⇒ her standing, no signature ──
const re = await connectors({ op: 'attach', name: 'Ligonier catalog', url: SERVER, reads: ['search_resources'] });
if (re.ok !== true) fail(`re-attach failed: ${JSON.stringify(re).slice(0, 300)}`);
const asRead = (re.connector as typeof conn).tools.find((t) => t.name === 'search_resources');
if (asRead?.kind !== 'read' || asRead.why !== 'declared') fail(`the declared read was not compiled as one: ${JSON.stringify(asRead)}`);
const answered = (await post('/harness/ask', { addressee: me.agent, message: 'search on Ligonier catalog for justification', plan: { steps: [{ toolId: search.capability, args: { q: 'justification', holder: me.agent } }] } })).reply as Reply;
if (answered.kind !== 'answer') fail(`the declared read did not answer under her standing: ${JSON.stringify(answered).slice(0, 300)}`);
const ro = resultOf(answered, search.capability) as { called?: boolean; kind?: string };
if (!ro.called || ro.kind !== 'read') fail(`the read did not run as a read: ${JSON.stringify(ro).slice(0, 200)}`);
console.log('  declared a read → answered under her standing, no signature');

// ── 4. the list, and the record is hers ──
const listed = (await post('/harness/ask', { addressee: me.agent, message: 'which mcp servers are connected', plan: { steps: [{ toolId: 'mcp.connectors.list', args: { holder: me.agent } }] } })).reply as Reply;
const lr = resultOf(listed, 'mcp.connectors.list') as { connectors?: Array<{ id: string; tools: Array<{ name: string; kind: string; why: string }> }> };
const mine = lr.connectors?.find((c) => c.id === conn.id);
if (!mine || mine.tools.find((t) => t.name === 'search_resources')?.why !== 'declared') fail(`the list does not carry the connector with its kinds: ${JSON.stringify(lr).slice(0, 300)}`);
console.log(`  listed: ${lr.connectors!.length} connector(s) · search_resources [read, declared] · record connector.mcp:${conn.id}`);

// ── 5. removed ⇒ gone ──
const removed = await connectors({ op: 'remove', id: conn.id });
if (removed.ok !== true) fail(`remove failed: ${JSON.stringify(removed).slice(0, 200)}`);
const gone = (await post('/harness/ask', { addressee: me.agent, message: 'search on Ligonier catalog for justification', plan: { steps: [{ toolId: search.capability, args: { q: 'justification', holder: me.agent } }] } })).reply as Reply;
const gtext = JSON.stringify(gone);
if (/"called":true/.test(gtext)) fail(`a removed connector's tool still ran: ${gtext.slice(0, 300)}`);
console.log(`  removed → the tool is gone (${gone.kind}${/unknown|removed|never attached|not offered|no such/i.test(gtext) ? ': refused as removed' : ''})`);

console.log(`\n✓ spec 404: a stranger's MCP server attached as HER connector — its tools compiled (acts by default), an act parked for her mandate and ran under it, its answer untrusted evidence, a declared read answered under her standing, the list and the record hers, removal final; no credential in any reply.`);
