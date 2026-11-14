/** Publish an existing signed service card through Home's standard AP Naming and
 * Registry projection ceremonies. The service owns each record; its person
 * steward approves each exact plan and signs its calls. No synthetic card hash.
 * NEXT_PUBLIC_CHAIN_ID=34348 pnpm exec tsx scripts/publish-service-listings.mts
 *   --release /path/to/public-release.json --by <persona> --out /path/to/receipts.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { buildExecuteBatchCallData } from '@agenticprimitives/agent-account';
import { issueVaultRecordScopeDelegation, toWire } from '../apps/home/src/lib/delegation';
import { MCP_SERVER_ID } from '../apps/home/src/lib/inbox-delivery';
const arg = (key: string) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? undefined : process.argv[i + 1]; };
if (process.env.NEXT_PUBLIC_CHAIN_ID !== '34348') throw Error('This ceremony requires explicit faithchain 34348.');
const path = arg('release'), by = arg('by'), out = arg('out');
if (!path || !by || !out) throw Error('--release, --by and --out are required');
const release = JSON.parse(readFileSync(path, 'utf8'));
const agent = String(release.agent).toLowerCase() as Address;
const cardId = release.smartAgentBinding?.binding?.cardResourceId;
if (!/^0x[0-9a-f]{40}$/.test(agent) || !cardId || !release.releaseId || release.smartAgentBinding.binding.canonicalAgentId !== `eip155:34348:${agent}`) throw Error('Release identity is incomplete or inconsistent');
const endpoint = release.card?.supportedInterfaces?.find((x: {protocolBinding?: string}) => x.protocolBinding === 'JSONRPC')?.url;
if (!endpoint || new URL(endpoint).origin !== new URL(release.cardUri).origin) throw Error('Card endpoint and bound origin differ');
const HOME = 'https://www.faithnet.me';
const j = async (r: Response) => { const text = await r.text(); try { return JSON.parse(text); } catch { throw Error(`Non-JSON response (${r.status})`); } };
const si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-web' }) }));
if (!si.homeSession || !si.agent) throw Error('Steward sign-in failed');
const sign = async (digest: Hex): Promise<Hex> => { const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${si.homeSession}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw Error('Steward signature refused'); return b.signature; };
const grant = toWire(await issueVaultRecordScopeDelegation(agent, si.agent, [{ server: MCP_SERVER_ID, resources: ['vault:agent-cards:*', 'vault:projections:*', 'vault:bindings:*', 'vault:approvals:*'], ops: ['read', 'write'] }], sign, 3600));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = await j(csrfRes);
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0]!, 'x-csrf-token': csrf.token ?? '' };
const mutation = () => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() });
const studio = async (op: string, args: Record<string, unknown>) => { const r = await j(await fetch(`${HOME}/a2a/agent-cards/${op}`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, requester: si.agent, args }) })); if (r.ok !== true) throw Error(`${op}: ${r.error ?? ''} ${r.detail ?? ''}`); return r; };
const pc = createPublicClient({ transport: http('https://a2a.faithnet.io/rpc') });
const execute = async (calls: Array<{chainId: number; to: Address; value: string; data: Hex}>) => {
 if (calls.some(x => x.chainId !== 34348)) throw Error('Unexpected publication chain');
 const callData = buildExecuteBatchCallData(calls.map(x => ({ to: x.to, value: BigInt(x.value), data: x.data })));
 const b = await j(await fetch(`${HOME}/a2a/account/build-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ sender: agent, callData }) }));
 if (!b.ok || !b.userOpHash) throw Error(`Build refused: ${b.error ?? b.detail}`);
 const s = await j(await fetch(`${HOME}/a2a/account/submit-call-userop`, { method: 'POST', headers: H, body: JSON.stringify({ userOp: { ...b.userOp, signature: await sign(b.userOpHash) } }) }));
 if (!s.ok || !s.transactionHash) throw Error(`Publication refused: ${s.error ?? s.detail}`);
 const receipt = await pc.waitForTransactionReceipt({ hash: s.transactionHash });
 if (receipt.status !== 'success') throw Error('Publication transaction reverted');
 return s.transactionHash;
};
const detail = await studio('card.get', { cardResourceId: cardId });
if (!(detail.releases ?? []).some((x: {releaseId?: string; state?: string}) => x.releaseId === release.releaseId && x.state === 'published')) throw Error('Selected card is not a published release in this service vault');
const receipts: unknown[] = [];
for (const family of ['ap-naming', 'ap-registry']) {
 const configuration = family === 'ap-naming' ? { name: release.name, a2aEndpoint: endpoint, publishCardUri: false } : { registry: CONTRACTS.agentRegistryBase, registryId: 'urn:ap:registry:faithnet-agents', entryId: `urn:ap:registry-entry:${release.name}`, claimSlots: [] };
 const configured = await studio('projection.configure', { family, configuration, cardResourceId: cardId, selectedReleaseId: release.releaseId, mutation: mutation() });
 const instanceId = configured.instance.instanceId;
 const preview = await studio('projection.preview', { instanceId });
 if (preview.result.diagnostics.some((x: {severity: string}) => x.severity === 'error')) throw Error(`${family}: projection validation failed`);
 const planned = await studio('projection.planPublication', { instanceId, mutation: mutation() });
 const planId = planned.plan.planId;
 await studio('projection.requestApproval', { instanceId, planId, mutation: mutation() });
 const approved = await studio('projection.approve', { instanceId, planId, mutation: mutation() });
 const signatures = [];
 for (const req of planned.signatureRequests) signatures.push({ digest: req.digest, signature: await sign(req.digest) });
 const hash = await execute(planned.contractCalls);
 const saved = await studio('projection.recordPublication', { instanceId, planId, approvalId: approved.approval.approvalId, transactions: [{ chainId: 34348, hash }], signatures, mutation: mutation() });
 if (saved.receipt.verification.result !== 'valid') throw Error(`${family}: on-chain publication did not verify`);
 const verified = await studio('binding.verify', { bindingId: saved.binding.bindingId });
 if (!verified.verdict.ok) throw Error(`${family}: binding verification failed`);
 receipts.push({ family, receipt: saved.receipt, binding: saved.binding, observed: verified.verdict.observed });
 writeFileSync(out, JSON.stringify({ agent, name: release.name, releaseId: release.releaseId, checkedAt: new Date().toISOString(), receipts }, null, 2) + '\n');
 console.log(`${family}: published and verified on chain · ${hash}`);
}
