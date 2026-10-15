/**
 * BOOTSTRAP A NEW ESTATE'S OWN KEYS AND SERVICE AGENTS — the step between "the town declares an estate"
 * and "the estate's Workers can be deployed".
 *
 *   CHAIN_APP_TOKEN=<token> npx tsx scripts/bootstrap-estate.mts --estate impact-agent [--dry-run]
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
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const estate = arg('--estate') ?? 'impact-agent';
const dry = process.argv.includes('--dry-run');
const token = process.env.CHAIN_APP_TOKEN;

// WHICH CHAIN. An estate belongs to a town, and a town is a chain (ap-town second-town runbook), so the
// addresses come from that chain's deployment file rather than from constants — the factory in particular,
// because a service agent's address is CREATE2 over it and the two chains' factories differ.
const RPC = arg('--rpc') ?? (token ? `https://rpc.faithnet.io?k=${token}` : '');
if (!RPC) { console.error('CHAIN_APP_TOKEN (faithchain) or --rpc <url> is required'); process.exit(1); }
// `--deployment <name>` reads the PUBLISHED package, which is what a product repo should normally do.
// `--deployment-file <path>` is for a chain whose addresses have not shipped in a release yet — a new town's
// file exists in Ring 0 before the next publish, and waiting for a release to charter an estate would be the
// tail wagging the dog. Said as a separate flag rather than a silent fallback, so the log shows which it was.
const deploymentFile = arg('--deployment-file');
const deploymentName = arg('--deployment') ?? 'faithchain';
const resolveFrom = createRequire(import.meta.url);
const deploymentPath = deploymentFile
  ? deploymentFile.replace(/^~/, process.env.HOME ?? '')
  : resolveFrom.resolve(`@agenticprimitives/contracts/deployments-${deploymentName}.json`);
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8')) as {
  chainId: number; entryPoint: Address; agentAccountFactory: Address;
};
const CHAIN_ID = deployment.chainId;
const ENTRY_POINT = deployment.entryPoint;
const FACTORY = deployment.agentAccountFactory;

// REUSE A KEY THAT ALREADY EXISTS, when one does. An AKCS key is CHAIN-AGNOSTIC: the same interactions-session
// key signs on every chain, so an estate moving towns keeps it — and because the new chain's service agents are
// chartered with it as custodian from the start, there is no custody rotation to forget (spec 441 §7.2 step 2
// exists precisely because that rotation is invisible when missed). Minting a fresh local key here would also
// undo spec 441 D3: no estate keeps a private key in a Worker secret.
const reuseInteractions = arg('--interactions-address') as Address | undefined;
// Whoever pays for the two creation transactions. On a fresh chain the deployer is funded at genesis; the AKCS
// relay key cannot sign here because its private half never leaves the CVM, which is the point of it.
const deployKeyFile = arg('--deploy-key-file');

// AN ESTATE MOVING CHAINS IS NOT A RE-MINT. Its custody root, MAC and session secrets are chain-agnostic and
// every vault binding depends on them, so minting fresh ones would orphan the estate's own records — while its
// SERVICE AGENTS are CREATE2 over a factory that differs per chain and must be chartered again. `--agents-only`
// is that operation: compute and deploy the two agents on this chain, print them, write nothing.
const agentsOnly = process.argv.includes('--agents-only');
const out = `.estate-${estate}.local`;
if (existsSync(out) && !dry && !agentsOnly) { console.error(`${out} already exists — this estate is bootstrapped; delete the file to re-mint (which orphans every account the old keys custody), or pass --agents-only to charter its agents on another chain`); process.exit(1); }

const hex32 = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const b64 = (n: number): string => randomBytes(n).toString('base64url');

const relay = deployKeyFile ? (readFileSync(deployKeyFile.replace(/^~/, process.env.HOME ?? ''), 'utf8').trim() as Hex) : generatePrivateKey();
const interactions = generatePrivateKey();
const homeMcp = generatePrivateKey();
const homeMcpAct = generatePrivateKey();
const interactionsAddr = reuseInteractions ?? privateKeyToAccount(interactions).address;

console.log(`chain ${CHAIN_ID} from ${deploymentPath}\n  entryPoint ${ENTRY_POINT}\n  factory    ${FACTORY}${reuseInteractions ? `\n  interactions key REUSED: ${reuseInteractions} (chain-agnostic — no custody rotation to do)` : ''}`);
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
  `# HEX, not base64url: the local-aes MAC provider takes this as \`sessionSecretHex\` and hex-decodes it, so a
  # base64url value throws \`Invalid byte sequence\` on the first interactions call — which the Home renders as
  # "turn on storage", naming nothing. impact-agent carried that for a day behind AKCS, which never reads this value
  # (2026-10-11). Prefixing \`0x\` to a base64url secret does not make it hex; the bytes must be hex.`,
  `A2A_MAC_SECRET=${hex32()}`,
  `GATEWAY_ASSERTION_SECRET=${b64(32)}`,
  `A2A_CUSTODY_BRIDGE_SECRET=${b64(32)}`,
  `A2A_SESSION_SECRET=${b64(32)}`,
  `# \`k1:0x<64 hex>\` — the key id is part of the value; the verifier splits on \`:\` and hex-decodes the half after it.`,
  `SESSION_JWT_SECRETS=k1:${hex32()}`,
  `# hex — the CSRF and vault-KEK paths hex-decode these two.`,
  `CSRF_SECRET=${hex32()}`,
  `OAUTH_SIGNING_SECRET=${b64(32)}`,
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

if (agentsOnly) {
  console.log(`\n--agents-only: nothing written. Put these two in [env.${estate}.vars] and in the estate's declaration:`);
  for (const [k, v] of Object.entries(agents)) console.log(`  ${k}=${v}`);
  console.log('  Every secret in the estate\'s .local file is chain-agnostic and stays as it is.');
  process.exit(0);
}
if (dry) { console.log(`\n--dry-run: would write ${out} (${lines.split('\n').length} lines)`); process.exit(0); }
writeFileSync(out, lines, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`\nwrote ${out} (0600). Put the two SA addresses in [env.${estate}.vars]; the rest go through scripts/set-estate-secrets.sh.`);
