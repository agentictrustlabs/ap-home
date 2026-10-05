/**
 * Backfill the private tree entry for an agent created through the ASK before the surface recorded it
 * (2026-09-03: the Ask's ceremony ended at the chain, so `nathan.team` was real, named, custodied — and
 * invisible in its owner's own home).
 *
 *   npx tsx scripts/backfill-ask-created-agent.mts <handle> <name> [parent]
 *   npx tsx scripts/backfill-ask-created-agent.mts nathan nathan.team
 *
 * Writes the SAME record the Home's create ceremony writes (ADR-0025 — the person↔agent link is a private
 * vault credential, never an on-chain edge). Reads the chain for everything it can: the agent's address
 * comes from the naming service, and custody is VERIFIED before anything is written — a tree entry for an
 * agent this person does not custody would be a lie the switcher then repeats.
 */
import { createPublicClient, http, type Address } from 'viem';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';

const HOME = 'https://www.faithnet.me';
const RPC = 'https://a2a.faithnet.io/rpc';
const CHAIN = 34348;
const NAMING = { registry: '0x60E949D52660A9D4143ecB0fdA56c0457f20aED9' as Address, universalResolver: '0xF343054e046A4145ccae499ECB28197394eE0798' as Address };

const [handle, name, parentArg] = process.argv.slice(2);
if (!handle || !name) throw new Error('usage: backfill-ask-created-agent.mts <handle> <name> [parent]');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 300), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: CHAIN, ...NAMING });

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error(`no session for ${handle}`);
const person = String(signin.agent).toLowerCase() as Address;

const agent = await naming.resolveName(name);
if (!agent) throw new Error(`${name} does not resolve on chain`);
const kind = name.split('.').pop() ?? 'org';

// Custody check — the tree says "this is mine", so verify it before writing it.
const personas = await j(await fetch(`${HOME}/connect/demo-personas`));
const custodian = (personas.personas as Array<{ sa: string; custodian: string }>).find((p) => p.sa.toLowerCase() === person)?.custodian as Address;
const custodied = await pub.readContract({ address: agent, abi: [{ type: 'function', name: 'isCustodian', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] }], functionName: 'isCustodian', args: [custodian] });
console.log(`${name} → ${agent}\n  ${handle} ${person}, credential ${custodian}, custodies it: ${custodied ? '✓' : '✗'}`);
if (!custodied) throw new Error('this person does not custody that agent — refusing to write a tree entry that claims otherwise');

const parent = (parentArg ?? person).toLowerCase() as Address;
const res = await fetch(`${HOME}/connect/related-orgs`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ person, orgAgent: agent, orgName: name, purpose: kind, kind, parent, proofHash: null }),
});
console.log(res.ok ? `  recorded under ${parent === person ? 'you' : parent} ✓` : `  FAILED ${res.status}: ${(await res.text()).slice(0, 200)}`);

const back = await j(await fetch(`${HOME}/connect/related-orgs?person=${person}`, { headers: { authorization: `Bearer ${token}` } }));
const row = (back.orgs ?? []).find((o: { orgAgent: string }) => o.orgAgent.toLowerCase() === agent.toLowerCase());
console.log(row ? `  reads back: ${row.orgName} (${row.kind ?? row.purpose}) ✓` : '  NOT in the tree read-back ✗');
