/** Read-only end-to-end check: name -> SA -> signed card -> bound public key -> ERC-1271. */
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type Address } from 'viem';
import { AgentNamingClient } from '@agenticprimitives/agent-naming';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { verifyCardAgainstOnChainBinding } from '@agenticprimitives/agent-profile/a2a';
import { universalSignatureValidatorAbi } from '@agenticprimitives/chain-state-viem';
const [name, uri, out] = process.argv.slice(2);
if (!name || !uri || !out || new URL(uri).protocol !== 'https:') throw Error('name https-card-uri output-file required');
const rpc = 'https://a2a.faithnet.io/rpc';
const pc = createPublicClient({ transport: http(rpc) });
const naming = new AgentNamingClient({ rpcUrl: rpc, chainId: 34348, registry: CONTRACTS.agentNameRegistry, universalResolver: CONTRACTS.agentNameUniversalResolver });
const agent = await naming.resolveName(name); if (!agent) throw Error('Name does not resolve');
const reverse = await naming.reverseResolve(agent); if (reverse !== name) throw Error('Reverse name does not agree');
const origin = new URL(uri).origin;
const response = await fetch(uri); if (!response.ok) throw Error(`Card HTTP ${response.status}`);
const raw = await response.text();
const binding = await (await fetch(`${origin}/.well-known/agent-card-binding.json`)).json();
const jwks = await (await fetch(`${origin}/.well-known/jwks.json`)).json();
const checked = await verifyCardAgainstOnChainBinding(raw, { smartAgent: agent as Address, cardUri: uri, binding, keys: jwks.keys }, {
 chainId: 34348, verifyHash: async (signer, digest, signature) => await pc.readContract({ address: CONTRACTS.universalSignatureValidator as Address, abi: universalSignatureValidatorAbi, functionName: 'isValidSig', args: [signer, digest, signature] }) === true,
});
if (!checked.ok) throw Error(`Card verification failed: ${checked.reason}`);
const card = JSON.parse(raw);
writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), name, agent, cardUri: uri, releaseId: response.headers.get('x-ap-card-release'), cardSource: response.headers.get('x-ap-card-source'), signedCardDigest: binding.binding.signedCardDigest, verification: checked, capabilities: card.skills.map((s: {id: string}) => s.id), endpoint: card.supportedInterfaces[0].url }, null, 2) + '\n');
console.log(`${name}: name round-trip, JWS and on-chain Smart Agent binding verified`);
