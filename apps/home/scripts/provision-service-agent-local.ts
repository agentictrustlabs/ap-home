/**
 * provision-service-agent-local.ts — a SERVICE-CLASS Smart Agent on a LOCAL chain, with its
 * service-agent wire.
 *
 * Downstream apps (engage-a2a signs as `engage-service.impact`, field-a2a as `field-service.impact`,
 * gather27-a2a as `gather27-workspace.impact`) each act AS a service identity they do not custody:
 * the worker signs with a KMS delegate key, authorized by a custodian-signed `service-agent-wire`
 * (a Delegation: delegator = the service SA, delegate = the key, timestamp-bounded, allowedMethods
 * pinned to the app's skills). On base-sepolia that identity exists and the wire is minted at the
 * Home ceremony. On a local chain neither exists — this script makes both, idempotently:
 *
 *   1. derive + deploy the service SA from the local factory ({ mode 0, custodians [dev EOA], salt 0 })
 *   2. claim `<handle>.impact` FROM the SA (register + setPrimaryName, paymaster-sponsored,
 *      custodian-signed) so forward AND reverse resolution agree — the app's readiness gate checks both
 *   3. build the wire for the given DELEGATE address (the app's AKCS/KMS key), caveated with the
 *      local timestamp + allowedMethods enforcers, custodian-signed (EIP-191 over the EIP-712
 *      delegation digest — the SA's ERC-1271 accepts a custodian's raw-or-191 ECDSA)
 *   4. write `demo/<handle>.local.json` (gitignored) and print it — the orchestration script feeds
 *      it into the app's `.dev.vars` and seeds the wire into the worker's local GRANTS KV.
 *
 * Lives beside provision-demo-personas-local.ts for the same reason it does: this app resolves the
 * exact packages the Home's own ceremonies use, so the wire here cannot drift from the real one.
 *
 * Usage:
 *   HANDLE=engage-service DELEGATE=0x… SKILLS=engagement.probe,engagement.respond,engagement.offer \
 *     pnpm exec tsx scripts/provision-service-agent-local.ts
 *   Optional: CUSTODIAN_KEY (default: anvil[1] — dev only), LOCAL_RPC_URL, DEPLOY_NETWORK,
 *             WIRE_DAYS (default 90).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient, buildExecuteBatchCallData, type ContractCall } from '@agenticprimitives/agent-account';
import { agentNameRegistryAbi, buildSetPrimaryNameCall, buildSubregistryRegisterCall, namehash } from '@agenticprimitives/agent-naming';
import {
  ROOT_AUTHORITY,
  buildCaveat,
  encodeAllowedMethodsTerms,
  encodeTimestampTerms,
  hashDelegation,
  type Delegation,
} from '@agenticprimitives/delegation';
import { skillSelector } from '@agenticprimitives/a2a';

const APP_ROOT = join(import.meta.dirname ?? __dirname, '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');
const NETWORK = process.env.DEPLOY_NETWORK ?? 'anvil';
const RPC_URL = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const HANDLE = process.env.HANDLE ?? 'engage-service';
const DELEGATE = (process.env.DELEGATE ?? '') as Address;
const SKILLS = (process.env.SKILLS ?? 'engagement.probe,engagement.respond,engagement.offer').split(',').map((s) => s.trim()).filter(Boolean);
const WIRE_DAYS = Number(process.env.WIRE_DAYS ?? '90');
// anvil[1] — the dev custodian of the service identity. Distinct from the delegate BY CONSTRUCTION:
// the app refuses at runtime if the key it signs with custodies the identity it signs as.
const CUSTODIAN_KEY = (process.env.CUSTODIAN_KEY ?? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') as Hex;
// anvil[0] — pays gas for the deploy. Public dev key; local chains only.
const GAS_PAYER: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const NAME_PARENT = 'impact';
const OUT = join(REPO_ROOT, 'demo', `${HANDLE}.local.json`);

if (!/^0x[0-9a-fA-F]{40}$/.test(DELEGATE)) throw new Error('DELEGATE (the app\'s KMS key address) is required');
const DEPLOYMENTS = join(REPO_ROOT, 'packages', 'contracts', `deployments-${NETWORK}.json`);
if (!existsSync(DEPLOYMENTS)) throw new Error(`${DEPLOYMENTS} not found — deploy the contracts first`);
const d = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) as {
  chainId: number; entryPoint: Address; agentAccountFactory: Address; delegationManager: Address;
  timestampEnforcer: Address; allowedMethodsEnforcer: Address;
  permissionlessSubregistry?: Address; agentNameRegistry?: Address; smartAgentPaymaster?: Address;
};

const pub = createPublicClient({ transport: http(RPC_URL) });
const chainId = Number(await pub.getChainId());
if (chainId !== d.chainId) throw new Error(`RPC chain ${chainId} ≠ deployments-${NETWORK}.json chain ${d.chainId}`);
const payer = privateKeyToAccount(GAS_PAYER);
const custodian = privateKeyToAccount(CUSTODIAN_KEY);
if (custodian.address.toLowerCase() === DELEGATE.toLowerCase()) {
  throw new Error('CUSTODIAN_KEY derives the DELEGATE address — the delegate must never custody the identity');
}
const accounts = new AgentAccountClient({ rpcUrl: RPC_URL, chainId, entryPoint: d.entryPoint, factory: d.agentAccountFactory });

// 1. Deploy the service SA.
const spec = { mode: 0, custodians: [custodian.address] as const, salt: 0n };
const sa = await accounts.getAddressForAgentAccount(spec);
const deployed = await accounts.isDeployed(sa);
if (!deployed) await accounts.createAgentAccountFromAccount(spec, payer);

// 2. Claim `<handle>.impact` from the SA — the same shape the Home's name claim runs.
async function claimName(): Promise<string> {
  if (!d.permissionlessSubregistry || !d.agentNameRegistry || !d.smartAgentPaymaster) return 'name: n/a (no naming/paymaster deployment)';
  const name = `${HANDLE}.${NAME_PARENT}`;
  const node = namehash(name) as Hex;
  const read = <T>(fn: 'owner' | 'primaryName', args: readonly unknown[]) =>
    pub.readContract({ address: d.agentNameRegistry!, abi: agentNameRegistryAbi, functionName: fn, args } as never).catch(() => null) as Promise<T | null>;
  const owner = ((await read<Address>('owner', [node])) ?? '0x0000000000000000000000000000000000000000').toLowerCase();
  const primary = ((await read<Hex>('primaryName', [sa])) ?? '0x').toLowerCase();
  if (primary === node.toLowerCase()) return `${name} (primary)`;
  const calls: ContractCall[] = [];
  if (owner === '0x0000000000000000000000000000000000000000') {
    calls.push(buildSubregistryRegisterCall({ subregistry: d.permissionlessSubregistry, label: HANDLE, newOwner: sa }));
  } else if (owner !== sa.toLowerCase()) {
    return `name: ${name} is owned by ${owner.slice(0, 10)}… — not claimed`;
  }
  calls.push(buildSetPrimaryNameCall({ registry: d.agentNameRegistry, node }));
  const { userOp, userOpHash } = await accounts.buildCallUserOp({
    sender: sa, callData: buildExecuteBatchCallData(calls), paymaster: d.smartAgentPaymaster,
  });
  userOp.signature = await custodian.signMessage({ message: { raw: userOpHash } });
  await accounts.submitCallUserOp(userOp, payer);
  const after = ((await read<Hex>('primaryName', [sa])) ?? '0x').toLowerCase();
  return after === node.toLowerCase() ? `${name} CLAIMED (primary set)` : 'name: userOp landed but primaryName not set';
}
const named = await claimName();

// 3. The wire: delegator = the service SA, delegate = the app's key, timestamp + allowedMethods.
const now = Math.floor(Date.now() / 1000);
const validUntil = now + WIRE_DAYS * 24 * 60 * 60;
const delegation: Delegation = {
  delegator: sa,
  delegate: DELEGATE,
  authority: ROOT_AUTHORITY,
  caveats: [
    buildCaveat(d.timestampEnforcer, encodeTimestampTerms(now - 300, validUntil)),
    buildCaveat(d.allowedMethodsEnforcer, encodeAllowedMethodsTerms(SKILLS.map((s) => skillSelector(s)))),
  ],
  // Deterministic per handle so re-runs replace rather than accumulate.
  salt: BigInt(keccak256(toBytes(`service-wire/${HANDLE}/v1`))),
  signature: '0x' as Hex,
};
const digest = hashDelegation(delegation, chainId, d.delegationManager);
delegation.signature = await custodian.signMessage({ message: { raw: digest } });

// 4. The wire in WIRE form (stringified salt) + everything the orchestration needs.
const wire = {
  delegator: delegation.delegator,
  delegate: delegation.delegate,
  authority: delegation.authority,
  caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? '0x' })),
  salt: delegation.salt.toString(),
  signature: delegation.signature,
};
const out = {
  handle: HANDLE,
  name: `${HANDLE}.${NAME_PARENT}`,
  chainId,
  sa: sa.toLowerCase(),
  custodian: custodian.address.toLowerCase(),
  delegate: DELEGATE.toLowerCase(),
  skills: SKILLS,
  enforcers: { timestamp: d.timestampEnforcer, allowedMethods: d.allowedMethodsEnforcer },
  wire,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.error(`  ${HANDLE.padEnd(16)} ${sa}  ${deployed ? 'exists' : 'DEPLOYED'}  ${named}  wire signed (→ ${OUT})`);
console.log(JSON.stringify(out));
