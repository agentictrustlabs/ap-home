// Put a demo estate's personas on another chain. A persona's Smart Agent is CREATE2 over the FACTORY and its
// custodian EOA, and the factory differs per chain — so the same person is a different address on each, and the
// roster's `sa` is chain-specific. Their custodian key does NOT change: it is the person, and the account is a
// facet (ADR-0010). Deploying costs the funded key a transaction and nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { AgentAccountClient } from '@agenticprimitives/agent-account';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const roster = arg('roster')!, depFile = arg('deployment-file')!, rpc = arg('rpc')!, out = arg('out');
const dry = process.argv.includes('--dry-run');
const dep = JSON.parse(readFileSync(depFile, 'utf8')) as { chainId: number; entryPoint: Address; agentAccountFactory: Address };
const people = JSON.parse(readFileSync(roster, 'utf8')) as Record<string, { sa: string; eoaPrivateKey: Hex; name?: string; blurb?: string }>;
const payer = readFileSync((arg('deploy-key-file') ?? '').replace(/^~/, process.env.HOME ?? ''), 'utf8').trim() as Hex;

const client = new AgentAccountClient({ rpcUrl: rpc, chainId: dep.chainId, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory });
console.log(`chain ${dep.chainId} · factory ${dep.agentAccountFactory}`);
const next: typeof people = {};
for (const [handle, p] of Object.entries(people)) {
  const custodian = privateKeyToAccount(p.eoaPrivateKey).address;
  const spec = { custodians: [custodian] as readonly Address[], salt: 0n };
  const sa = await client.getAddressForAgentAccount(spec);
  const already = await client.isDeployed(sa).catch(() => false);
  console.log(`${handle.padEnd(8)} ${p.sa} → ${sa}  custodian ${custodian}  ${already ? 'already deployed' : dry ? 'would deploy' : 'deploying…'}`);
  if (!already && !dry) {
    await client.createAgentAccountFromPrivateKey(spec, payer);
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) { ok = await client.isDeployed(sa).catch(() => false); if (!ok) await new Promise((r) => setTimeout(r, 1500)); }
    if (!ok) { console.error(`  ${handle}: not visible after deploy`); process.exit(1); }
    console.log('  deployed');
  }
  next[handle] = { ...p, sa };
}
if (out && !dry) { writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); console.log(`\nwrote ${out} — this is the new DEMO_PERSONA_KEYS for that Home`); }
