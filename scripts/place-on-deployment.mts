/**
 * PLACE AN AGENT ON A DEPLOYMENT — spec 366 R4: where an agent is asked is what its NAME publishes.
 *
 *   EDGE=https://edge-b.faithnet.io BASE=b.faithnet.io npx tsx scripts/place-on-deployment.mts <steward-handle> <name>…
 *
 * For each name, writes the two records a routed ask resolves through — `atl:a2aEndpoint` (that deployment's
 * ingress, `<EDGE>/api/a2a/<name>`) and `atl:cardUri` (the card that deployment serves for the name) — with
 * ONE gasless userOp from the name's own Smart Agent, signed by the steward's custodian through the Home's
 * persona-sign (the person for their own name; the steward for an organization they custody). No subdomain
 * convention decides anything after this: the record does. Verified by reading the records back.
 */
import { AgentNamingClient, buildRecordCalls, namehash } from '@agenticprimitives/agent-naming';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { hostForName } from '../apps/demo-a2a/src/host-context.js';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const EDGE = (process.env.EDGE ?? '').replace(/\/$/, '');
const BASE = process.env.BASE ?? '';
const PARENTS = (process.env.AGENT_NAME_PARENTS ?? 'me,impact').split(',');
const [steward, ...names] = process.argv.slice(2);
if (!EDGE || !BASE || !steward || names.length === 0) throw new Error('usage: EDGE=https://edge-b… BASE=b.faithnet.io place-on-deployment.mts <steward-handle> <name>…');
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const naming = new AgentNamingClient({ rpcUrl: process.env.RPC_URL ?? 'https://rpc.faithnet.io', chainId: 34348, registry: CONTRACTS.agentNameRegistry as Address, universalResolver: CONTRACTS.agentNameUniversalResolver as Address });

const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: steward, client_id: 'demo-web' }) }));
if (!si.homeSession) throw new Error(`no session for ${steward}`);
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };

for (const name of names) {
  console.log(`\n── ${name} → ${EDGE} ──`);
  const sa = await naming.resolveName(name);
  if (!sa) { console.log('  the registry names no such agent'); continue; }
  const host = hostForName(name, BASE, PARENTS);
  if (!host) { console.log('  no host on that zone for this name shape'); continue; }
  const records = { a2aEndpoint: `${EDGE}/api/a2a/${name}`, cardUri: `https://${host}/.well-known/agent-card.json` };
  const before = await naming.getRecords(name);
  console.log(`  ${sa}  now: a2aEndpoint ${before.a2aEndpoint ?? '-'} · cardUri ${before.cardUri ?? '-'}`);
  if (before.a2aEndpoint === records.a2aEndpoint && before.cardUri === records.cardUri) { console.log('  already placed'); continue; }
  const calls = buildRecordCalls({ resolver: CONTRACTS.agentNameResolver as Address, node: namehash(name), records });
  const callData = buildExecuteBatchCallData(calls.map((c) => ({ to: c.to, value: c.value, data: c.data })));
  let txHash: string | undefined; let lastErr = '';
  for (let i = 0; i < 4 && !txHash; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2500));
    const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: sa, callData }) }));
    if (!b.ok || !b.userOpHash) { lastErr = `${b.error ?? ''} ${b.detail ?? JSON.stringify(b).slice(0, 200)}`; continue; }
    const signature = await sign(b.userOpHash as Hex);
    const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature } }) }));
    if (s.ok) txHash = s.transactionHash; else lastErr = `${s.error ?? ''} ${s.detail ?? JSON.stringify(s).slice(0, 200)}`;
  }
  if (!txHash) { console.log(`  ✗ the record write did not go through: ${lastErr}`); continue; }
  const after = await naming.getRecords(name);
  console.log(`  tx ${txHash}\n  now: a2aEndpoint ${after.a2aEndpoint ?? '-'} · cardUri ${after.cardUri ?? '-'}`);
  console.log(after.a2aEndpoint === records.a2aEndpoint && after.cardUri === records.cardUri ? '  ✓ placed' : '  ✗ the records read back differently');
}
