/**
 * Spec 387 W2 — RECORD THE STEWARD LINK a scripted charter left unwritten. The Home's org-create ceremony writes
 * the person's steward link (their `related:` projection + `relationships.data`) after the Ask charters; a charter
 * driven from a script (`charter-ligonier.mts`) chartered the agents and wrote no link, so every steward-gated
 * call at them (assign a playbook, enable the assistant) answered "only the agent's custodian may…".
 *
 *   npx tsx scripts/record-service-stewardship.mts            (reads demo/ligonier.faithnet.json; alice stewards both)
 *   NOTE=demo/coach.faithnet.json BY=bob npx tsx scripts/record-service-stewardship.mts
 *                                                             (a service a PERSON chartered directly — the coach)
 *
 * What it does, per agent (the org, then the service under it): a fresh STEWARDSHIP wire agent → alice's SA in
 * the Home's own shape (`siteCaveats`: timestamp + value 0 + governance allowedTargets), signed by the agent's
 * custodian (alice, persona-sign → ERC-1271 by the agent), then posted to /connect/related-orgs under her
 * session. Same artifact the ceremony would have written; the DO and the Home re-verify it on every use.
 */
import { hashDelegation, buildCaveat, encodeTimestampTerms, encodeValueTerms, encodeAllowedTargetsTerms, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { toHex, type Address, type Hex } from 'viem';
import { readFileSync } from 'node:fs';

const HOME = 'https://www.faithnet.me';
const CHAIN = 34348;
const DAYS = Number(process.env.DAYS ?? 3650);
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const NOTE = process.env.NOTE ?? 'demo/ligonier.faithnet.json';
const BY = process.env.BY ?? 'alice';
const note = JSON.parse(readFileSync(NOTE, 'utf8')) as { org?: { name: string; sa: Address }; service: { name: string; sa: Address } };
const alice = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: BY, client_id: 'demo-web' }) }));
if (!alice.homeSession) throw new Error('no alice session');
const ME = String(alice.agent).toLowerCase() as Address;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${alice.homeSession}` };
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: auth, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`); return b.signature; };

const validUntil = Math.floor(Date.now() / 1000) + DAYS * 86_400;
const targets = [CONTRACTS.agentRelationship, CONTRACTS.agentNameRegistry, CONTRACTS.permissionlessSubregistry] as Address[];
async function stewardshipWire(agent: Address): Promise<Record<string, unknown>> {
  const salt = BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const d: Delegation = {
    delegator: agent, delegate: ME, authority: ROOT_AUTHORITY,
    caveats: [
      buildCaveat(CONTRACTS.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
      buildCaveat(CONTRACTS.valueEnforcer as Address, encodeValueTerms(0n)),
      buildCaveat(CONTRACTS.allowedTargetsEnforcer as Address, encodeAllowedTargetsTerms(targets)),
    ],
    salt, signature: '0x',
  };
  d.signature = await sign(hashDelegation(d, CHAIN, CONTRACTS.delegationManager as Address));
  return { ...d, salt: salt.toString() };
}

const orgs = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: auth }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship: string }>;
const has = (sa: string) => orgs.some((o) => o.orgAgent.toLowerCase() === sa.toLowerCase() && o.relationship === 'steward');
// An org and the service under it (ligonier), or a service chartered straight under the person (the coach).
const agents: Array<[Address, string, string, Address]> = note.org
  ? [[note.org.sa, note.org.name, 'org', ME], [note.service.sa, note.service.name, 'service', note.org.sa]]
  : [[note.service.sa, note.service.name, 'service', ME]];
for (const [agent, name, kind, parent] of agents) {
  const sa = agent.toLowerCase() as Address;
  if (has(sa)) { console.log(`· ${name} ${sa}: already a steward link`); continue; }
  const wire = await stewardshipWire(sa);
  const r = await j(await fetch(`${HOME}/connect/related-orgs`, { method: 'POST', headers: auth, body: JSON.stringify({
    person: ME, orgAgent: sa, orgName: name, purpose: kind === 'service' ? 'service' : 'organization', requestedBy: 'record-service-stewardship',
    kind, parent: parent.toLowerCase(), relationship: 'steward', stewardshipDelegation: wire,
  }) }));
  console.log(`${r.ok === true || r.link || r.orgAgent ? '✓' : '✗'} ${name} ${sa} ← steward link (parent ${parent.slice(0, 10)}…): ${JSON.stringify(r).slice(0, 160)}`);
}
const after = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: auth }))).orgs ?? []) as Array<{ orgAgent: string; orgName: string; relationship: string; kind?: string }>;
for (const o of after.filter((o) => agents.some(([sa]) => sa.toLowerCase() === o.orgAgent.toLowerCase()))) console.log(`  now: ${o.orgName} ${o.orgAgent} ${o.relationship} ${o.kind ?? ''}`);
