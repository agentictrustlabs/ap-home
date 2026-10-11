/**
 * AN ESTATE'S OWN DEMO PEOPLE — distinct agents, not a copy of another estate's roster.
 *
 *   CHAIN_APP_TOKEN=<token> npx tsx scripts/provision-estate-personas.mts --estate imbnet [--dry-run]
 *
 * A demo persona is an EOA-custodied Smart Agent the Home holds the key for (`DEMO_PERSONA_KEYS`), so it
 * can sign in with no wallet and no passkey. These are generated fresh per estate ON PURPOSE: faithnet's
 * Alice is a different person from imbnet's, reusing her key would make one human two estates' member at
 * once, and the whole reason imbnet exists is that its people are its own.
 *
 * Writes `demo/personas.<estate>.json` (0600) — the file whose contents become DEMO_PERSONA_KEYS.
 */
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate') ?? 'imbnet';
const dry = process.argv.includes('--dry-run');
const token = process.env.CHAIN_APP_TOKEN;
if (!token) { console.error('CHAIN_APP_TOKEN required'); process.exit(1); }

// IMB-flavoured and deliberately unlike faithnet's roster (Alice Okoro / Bob Tanaka / Carol Mbeki …):
// different given names, different surnames, different regions, so a screenshot of one estate can never
// be mistaken for the other.
const PEOPLE = [
  { handle: 'maya',    name: 'Maya Fernandes',  blurb: 'Sends and supports workers in Lusophone West Africa.' },
  { handle: 'samuel',  name: 'Samuel Adeyemi',  blurb: 'Coordinates training for church planters in the Sahel.' },
  { handle: 'priya',   name: 'Priya Raghavan',  blurb: 'Tracks engagement among unreached peoples in South Asia.' },
  { handle: 'tomas',   name: 'Tomás Vargas',    blurb: 'Mobilises sending churches across the Southern Cone.' },
  { handle: 'hannah',  name: 'Hannah Whitfield', blurb: 'Member care for field teams on long assignments.' },
] as const;

const RPC = `https://rpc.faithnet.io?k=${token}`;
const client = new AgentAccountClient({
  rpcUrl: RPC, chainId: 34348,
  entryPoint: '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5',
  factory: '0x464eEe7518c3c97DA570592481329E0627E9a3B8',
});

const out = `demo/personas.${estate}.json`;
if (existsSync(out) && !dry) { console.error(`${out} exists — delete it to re-mint (which abandons every account the old keys custody)`); process.exit(1); }

// The relay that pays for the deploys. faithchain gas is free, so a fresh key needs no funding.
const relay = generatePrivateKey();
const roster: Record<string, { sa: string; eoaPrivateKey: string; name: string; blurb: string }> = {};

for (const p of PEOPLE) {
  const pk = generatePrivateKey();
  const custodian = privateKeyToAccount(pk).address;
  const spec = { custodians: [custodian] as readonly Address[], salt: 0n };
  const sa = await client.getAddressForAgentAccount(spec);
  const already = await client.isDeployed(sa).catch(() => false);
  console.log(`${p.handle.padEnd(8)} ${sa}  ${already ? 'already deployed' : dry ? 'would deploy' : 'deploying…'}`);
  if (!already && !dry) {
    await client.createAgentAccountFromPrivateKey(spec, relay);
    // The gateway caches reads: a just-created address reads empty for a beat. Bounded retry of the SAME
    // call (ADR-0013) — never a second mechanism — tells "not yet visible" from "not there".
    let live = false;
    for (let i = 0; i < 10 && !live; i++) { live = await client.isDeployed(sa).catch(() => false); if (!live) await new Promise((r) => setTimeout(r, 1500)); }
    if (!live) { console.error(`  ${p.handle}: deploy did not take — stopping rather than writing a roster naming an account that is not there`); process.exit(1); }
    console.log('  deployed');
  }
  roster[p.handle] = { sa: sa.toLowerCase(), eoaPrivateKey: pk, name: p.name, blurb: p.blurb };
}

if (dry) { console.log(`\n--dry-run: would write ${out}`); process.exit(0); }
writeFileSync(out, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`\nwrote ${out} (0600) — its CONTENTS are the DEMO_PERSONA_KEYS value for this estate's Home.`);
console.log('Each persona still needs, in this order: an on-chain person profile (declareAgentType), a vault key');
console.log('(blocked until the estate is on AKCS), then a public name — which is a PAID claim on a priced root.');
