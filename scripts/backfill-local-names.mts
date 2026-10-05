/**
 * BACKFILL PRIVATE/LOCAL NAMES — so a member who holds an agent that never claimed a PUBLIC name sees the name
 * its owner gave it (marked "<name> *"), not a bare address, on the trust graph and everywhere else.
 *
 *   npx tsx scripts/backfill-local-names.mts <steward-handle> [HOME_URL]
 *
 * Run AS the steward of the agents. For every agent the steward holds that has a real (non-address) name, this
 * writes the rebuildable `org-localname:<agent>` projection (`/connect/related-orgs` {orgLocalName}). A member's
 * `related-orgs` then fills that name in for any link still showing the raw address, marking it LOCAL when the
 * agent has no public name (checked here with a reverse-resolve) and NOT local when it does (so a public name is
 * shown without the `*`). Resolution only — nothing here grants anything; the name is the owner's, shared to those
 * who already hold the agent. Idempotent.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import type { Address } from '@agenticprimitives/types';

// usage: backfill-local-names.mts <steward-handle> [HOME_URL] [--as <persona-sa>]
//   --as <persona-sa>: run as a PERSONA the handle steers (a cast character), entered via demo-signin { sa, as }.
//                      The backfill only reads + writes over the bearer, so no persona signer is needed.
const argv = process.argv.slice(2);
const asIdx = argv.indexOf('--as');
const asSa = asIdx >= 0 ? (argv[asIdx + 1] ?? '').toLowerCase() : '';
const positional = argv.filter((a, i) => a !== '--as' && (asIdx < 0 || i !== asIdx + 1));
const handle = positional[0];
const HOME = positional[1] ?? process.env.HOME_URL ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
if (!handle) throw new Error('usage: backfill-local-names.mts <steward-handle> [HOME_URL] [--as <persona-sa>]');

const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 160), _status: r.status }; } };

const C = getDeployments('faithchain') as unknown as Record<string, string> & { chainId: number };
const naming = new AgentNamingClient({ rpcUrl: RPC, chainId: C.chainId, registry: C.agentNameRegistry as Address, universalResolver: C.agentNameUniversalResolver as Address });

// The acting steward: a base account (personaCustodian) or a persona it steers (enter-as).
let steward: { bearer: string; agent: Address };
if (asSa) {
  if (!isAddr(asSa)) throw new Error('--as must be a persona agent address');
  const base = await personaCustodian(HOME, handle);
  const ea = (await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sa: base.agent, as: asSa, client_id: 'demo-web' }) }))) as { homeSession?: string; agent?: string; error?: string };
  if (!ea.homeSession || (ea.agent ?? '').toLowerCase() !== asSa) throw new Error(`${handle} could not enter as ${asSa}: ${JSON.stringify(ea).slice(0, 160)}`);
  steward = { bearer: ea.homeSession, agent: asSa as Address };
  console.log(`acting as persona ${asSa} (steered by ${handle})`);
} else {
  const sc = await personaCustodian(HOME, handle);
  steward = { bearer: sc.bearer, agent: sc.agent };
}
const body = (await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${steward.bearer}` } }))) as {
  orgs?: Array<{ orgAgent: string; orgName?: string; kind?: string; relationship?: string }>;
};
const rows = body.orgs ?? [];
// Only agents the steward HOLDS (so the projection write is authorised) and that carry a real local name.
const named = rows.filter((o) => (o.relationship ?? 'steward') !== 'member' && (o.relationship ?? '') !== 'self'
  && o.orgName && !isAddr(String(o.orgName)) && o.orgName.toLowerCase() !== String(o.orgAgent).toLowerCase());
console.log(`${handle} holds ${rows.length} agents; ${named.length} carry a local name to project.`);

let wrote = 0;
for (const o of named) {
  const agent = String(o.orgAgent).toLowerCase() as Address;
  const pub = await naming.reverseResolve(agent).catch(() => null);
  const isLocal = !pub; // has a public name ⇒ not a local-only name (surfaces show it without the `*`)
  const res = await j(await fetch(`${HOME}/connect/related-orgs`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${steward.bearer}` },
    body: JSON.stringify({ person: steward.agent, orgAgent: agent, orgLocalName: { name: o.orgName, isLocal } }),
  }));
  if (res.ok === true) { wrote += 1; console.log(`  ${agent.slice(0, 10)} "${o.orgName}" ${isLocal ? '(local *)' : '(public)'}`); }
  else console.log(`  ${agent.slice(0, 10)} SKIP: ${JSON.stringify(res).slice(0, 120)}`);
}
console.log(`done — ${wrote}/${named.length} org-localname projections written.`);
