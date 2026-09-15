/**
 * TURN ON THE DEMO PEOPLE'S MESSAGING RAIL — the wire a person's agent signs messages with, and the transport grant that
 * names who it may deliver to (spec 341 §5.1). At the reference Home the sign-in ceremony provisions it in the browser;
 * a persona that only ever signs in through `/connect/demo-signin` (a gate, an estate) never opens a browser, and every
 * send from their agent — a DM, a routine's answer, a reminder — is refused `wire_absent` (found on ap-home's estate,
 * 2026-09-15). The same signature the ceremony would make, made here by the persona's custodian (`persona-sign`).
 *
 *   HOME_URL=… A2A_URL=… CHAIN=faithchain npx tsx scripts/provision-persona-messaging.mts <handle…>
 *
 * Recipients = the fixture's organization (members are resolved live at the gate), the name registry (any named agent —
 * only meaningful for a NAMED person), and every other handle given (so the demo people reach each other by address
 * even before names). A wire already present is WIDENED, never narrowed (the rail unions recipients). Grants nothing
 * beyond delivery: a wire says whose signatures count as hers and whom she may write to.
 */
import { personaCustodian, enableMessaging } from '@agenticprimitives/runtime-member';
import type { Address } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const A2A = process.env.A2A_URL ?? 'https://a2a.faithnet.io';
const CHAIN_NAME = process.env.CHAIN ?? 'faithchain';
const HANDLES = process.argv.slice(2);
if (!HANDLES.length) { console.error('usage: provision-persona-messaging.mts <handle…>'); process.exit(2); }
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const contracts = { chainId: C.chainId, delegationManager: C.delegationManager, timestampEnforcer: C.timestampEnforcer, allowedMethodsEnforcer: C.allowedMethodsEnforcer, valueEnforcer: C.valueEnforcer, allowedTargetsEnforcer: C.allowedTargetsEnforcer, agentRelationship: C.agentRelationship, agentNameRegistry: C.agentNameRegistry, permissionlessSubregistry: C.permissionlessSubregistry } as never;
const extra = (process.env.RECIPIENTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)) as Address[];

const people = await Promise.all(HANDLES.map(async (h) => ({ handle: h, custodian: await personaCustodian(HOME, h) })));
for (const p of people) {
  const others = people.filter((o) => o.handle !== p.handle).map((o) => o.custodian.agent);
  const recipients = [...new Set([C.agentNameRegistry.toLowerCase() as Address, ...others, ...extra])];
  try {
    const out = await enableMessaging({ a2a: A2A, member: p.custodian.agent, recipients, contracts, custodian: p.custodian });
    console.log(`${p.handle} ${p.custodian.agent}: messaging on — ${out.recipients.length} recipient(s), wire ${out.hash.slice(0, 12)}…`);
  } catch (e) {
    console.log(`${p.handle}: FAILED ${e instanceof Error ? e.message : String(e)}`);
  }
}
