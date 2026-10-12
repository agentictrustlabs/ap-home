/**
 * BOOTSTRAP A NEW ESTATE'S OWN KEYS AND SERVICE AGENTS — the step between "the town declares an estate"
 * and "the estate's Workers can be deployed".
 *
 *   CHAIN_APP_TOKEN=<token> npx tsx scripts/bootstrap-estate.mts --estate imbnet [--dry-run]
 *
 * An estate shares the chain and the contracts with its siblings and shares NOTHING else. Its persons are
 * different Smart Agents from a sibling's persons of the same name, because a KMS-custodied home is a CREATE2
 * address over a derived custodian and the custody roots differ. So a new estate needs, before any Worker of
 * its own can run:
 *
 *   · a CUSTODY ROOT       — the seed its persons' custodians derive from (local-aes; an in-Worker secret)
 *   · a RELAY key          — the EOA that sends its userOps (faithchain's gas is free, so it needs no funding)
 *   · an INTERACTIONS key  — the delegate named inside every principal-signed session leaf. NEVER the relay
 *                            key: sharing it would make the relayer a delegate of every principal's grant.
 *   · two SERVICE AGENTS custodied by that interactions key, salt 0 and salt 1:
 *       INTERACTIONS_SERVICE_SA — what existing grants name (changing it stales every one of them)
 *       HARNESS_AGENT_SA        — what the agent ACTS AS when it executes under a mandate
 *     Both are DEPLOYED here rather than left counterfactual, so an ERC-1271 check against them is an
 *     ordinary call and not a 6492 wrapper every verifier has to understand.
 *   · MAC / assertion / session secrets, each shared by exactly the Workers that must agree on it.
 *
 * The output is written to `.estate-<name>.local` (0600, gitignored) — the file scripts/set-estate-secrets.sh
 * reads. Nothing is printed but addresses: a key value never reaches this process's stdout.
 */
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate') ?? 'imbnet';
const dry = process.argv.includes('--dry-run');
const token = process.env.CHAIN_APP_TOKEN;
if (!token) { console.error('CHAIN_APP_TOKEN is required (a faithchain gateway app token with writes allowed)'); process.exit(1); }

const RPC = `https://rpc.faithnet.io?k=${token}`;
const CHAIN_ID = 34348;
const ENTRY_POINT = '0xf7855250B3363AB7649B10957d8908A9AFcdD4B5' as Address;
const FACTORY = '0x464eEe7518c3c97DA570592481329E0627E9a3B8' as Address;

const out = `.estate-${estate}.local`;
if (existsSync(out) && !dry) { console.error(`${out} already exists — this estate is bootstrapped; delete the file to re-mint (which orphans every account the old keys custody)`); process.exit(1); }

const hex32 = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const b64 = (n: number): string => randomBytes(n).toString('base64url');

const relay = generatePrivateKey();
const interactions = generatePrivateKey();
const homeMcp = generatePrivateKey();
const homeMcpAct = generatePrivateKey();
const interactionsAddr = privateKeyToAccount(interactions).address;

const client = new AgentAccountClient({ rpcUrl: RPC, chainId: CHAIN_ID, entryPoint: ENTRY_POINT, factory: FACTORY });

const specs = [
  { name: 'INTERACTIONS_SERVICE_SA', salt: 0n, why: 'what existing grants name' },
  { name: 'HARNESS_AGENT_SA', salt: 1n, why: 'what the agent acts as under a mandate' },
] as const;

const agents: Record<string, Address> = {};
for (const s of specs) {
  const spec = { custodians: [interactionsAddr] as readonly Address[], salt: s.salt };
  const addr = await client.getAddressForAgentAccount(spec);
  agents[s.name] = addr;
  const deployed = await client.isDeployed(addr).catch(() => false);
  console.log(`${s.name} = ${addr}  (salt ${s.salt}, ${s.why})  ${deployed ? 'already deployed' : dry ? 'would deploy' : 'deploying…'}`);
  if (!deployed && !dry) {
    try { await client.createAgentAccountFromPrivateKey(spec, relay); }
    catch (e) { console.error(`  deploy threw for ${s.name}: ${String(e).slice(0, 500)}`); process.exit(1); }
    // The gateway caches reads, so the code at a just-created address can read empty for a beat. A bounded
    // retry of the SAME call (never a second mechanism — ADR-0013) is what tells the difference between
    // "not yet visible" and "not there".
    let now = false;
    for (let i = 0; i < 10 && !now; i++) { now = await client.isDeployed(addr).catch(() => false); if (!now) await new Promise((r) => setTimeout(r, 1500)); }
    if (!now) { console.error(`  deploy did not take for ${s.name} — stopping rather than writing a file that names an account that is not there`); process.exit(1); }
    console.log('  deployed');
  }
}

const lines = [
  `# ${estate} — the estate's own keys and secrets. Generated ${new Date().toISOString()} by scripts/bootstrap-estate.mts.`,
  `# 0600, gitignored, and the ONLY copy: the custody root cannot be regenerated without orphaning every person's home.`,
  `ESTATE=${estate}`,
  `# chain`,
  `RPC_URL=${RPC}`,
  `# relay + interactions (addresses: ${privateKeyToAccount(relay).address} / ${interactionsAddr})`,
  `A2A_MASTER_PRIVATE_KEY=${relay}`,
  `A2A_INTERACTIONS_SESSION_PRIVATE_KEY=${interactions}`,
  `# the custody root every person's custodian derives from — local-aes, in-Worker`,
  `A2A_CUSTODY_ROOT_KEY=${hex32()}`,
  `# shared by exactly the Workers that must agree: runtime+vault (MAC), runtime+vault+edge (assertion), runtime+Home (bridge)`,
  `A2A_MAC_SECRET=${b64(32)}`,
  `GATEWAY_ASSERTION_SECRET=${b64(32)}`,
  `A2A_CUSTODY_BRIDGE_SECRET=${b64(32)}`,
  `A2A_SESSION_SECRET=${b64(32)}`,
  // TWO SECRETS ARE NOT OPAQUE STRINGS, and a wrong shape is a 500 at the first browser request rather
  // than a refusal at boot: `SESSION_JWT_SECRETS` is `<kid>:<0x + 64 hex>` (connect-auth splits on the
  // first colon and hex-decodes the tail, requiring >= 16 bytes) and `CSRF_SECRET` is hex that viem's
  // `hexToBytes` must accept. Base64url for either ends as
  // `Invalid byte sequence (... ) at hexToBytes -> loadCsrfSecret`, which names the loader and not the
  // secret. The rest below are opaque to their readers and may be any high-entropy string.
  `SESSION_JWT_SECRETS=k1:${hex32()}`,
  `CSRF_SECRET=${hex32()}`,
  `OAUTH_SIGNING_SECRET=${b64(32)}`,
  // HEX too: `localKekEnabled` tests /^(0x)?[0-9a-fA-F]{32,}$/ and a base64url value simply reads as
  // 'no local KEK', so `POST /custody/vault-key/provision` answers 501 and the person's vault never
  // turns on — the Home shows 'Turn on storage' forever and every record read is `vault_key_unauthorized`.
  `DEMO_VAULT_LOCAL_KEK_SECRET=${hex32()}`,
  `DEMO_SIGNER_SECRET=${b64(32)}`,
  `TOKEN_SECRET=${b64(32)}`,
  `HOME_MCP_PRIVATE_KEY=${homeMcp}`,
  `HOME_MCP_ACT_KEY=${homeMcpAct}`,
  `# the two service agents, deployed above — these are wrangler VARS, not secrets`,
  `INTERACTIONS_SERVICE_SA=${agents.INTERACTIONS_SERVICE_SA}`,
  `HARNESS_AGENT_SA=${agents.HARNESS_AGENT_SA}`,
  '',
].join('\n');

if (dry) { console.log(`\n--dry-run: would write ${out} (${lines.split('\n').length} lines)`); process.exit(0); }
writeFileSync(out, lines, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`\nwrote ${out} (0600). Put the two SA addresses in [env.${estate}.vars]; the rest go through scripts/set-estate-secrets.sh.`);
