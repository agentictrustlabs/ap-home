/** Prepare separate CSPRNG demo-person keys and public address derivations. No runtime
 * receives a person's custodian key. Account deployment, Home admission and service
 * chartering remain the existing AP ceremonies. Re-running never rotates a key. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AgentAccountClient } from '@agenticprimitives/agent-account';
import { getDeployments } from '@agenticprimitives/contracts/deployments';
import { createPublicClient, http, type Hex } from 'viem';

const opt = (key: string) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? undefined : process.argv[i + 1]; };
const secretFile = opt('secret-file');
if (!secretFile?.startsWith('/') || !process.argv.includes('--prepare')) throw new Error('Usage: --prepare --secret-file <absolute path outside the repository>');
if (secretFile.startsWith(process.cwd() + '/')) throw new Error('Custodian keys must live outside the repository');
const rpc = process.env.RPC_URL ?? 'https://rpc.faithnet.io';
const dep = getDeployments('faithchain');
const client = new AgentAccountClient({ rpcUrl: rpc, chainId: 34348, entryPoint: dep.entryPoint, factory: dep.agentAccountFactory });
const publicClient = createPublicClient({ transport: http(rpc) });
if (await publicClient.getChainId() !== 34348) throw new Error('This provisioning batch is only for Faithnet/faithchain 34348');
const seeds = JSON.parse(readFileSync('demo/isl-scientists.profiles.json', 'utf8'));
type Person = { name: string; blurb: string; eoaPrivateKey: Hex; sa?: Hex; demoGroup?: string; publicOnlyClients?: string[]; archetypeId?: string };
const roster: Record<string, Person> = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, 'utf8')) : {};
mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
const persist = () => { writeFileSync(secretFile, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 }); chmodSync(secretFile, 0o600); };
const people = [];
for (const profile of seeds.scientists) {
  const handle: string = profile.homeHandle;
  if (!roster[handle]) {
    roster[handle] = { name: `${profile.displayName} (AI scientist)`, blurb: `${profile.headline}. ${profile.disclosure}`, eoaPrivateKey: generatePrivateKey() };
    persist();
  }
  const person = roster[handle]!;
  person.demoGroup = 'isl-scientists';
  person.publicOnlyClients = ['isl-workbench'];
  person.archetypeId = profile.archetypeContentId;
  const key = privateKeyToAccount(person.eoaPrivateKey);
  const sa = await client.getAddressForAgentAccount({ custodians: [key.address], salt: 0n });
  if (person.sa && person.sa.toLowerCase() !== sa.toLowerCase()) throw new Error(`Factory/identity drift for ${handle}; do not re-key or overwrite`);
  person.sa = sa; persist();
  const deployed = await client.isDeployed(sa);
  people.push({ id: profile.id, handle, displayName: profile.displayName, personSa: sa, custodianAddress: key.address, custodianPublicKey: key.publicKey, deployed, serviceSa: null });
  console.log(`${handle}: ${sa}; ${deployed ? 'deployed' : 'not deployed'}`);
}
writeFileSync('demo/isl-scientists.identities.json', JSON.stringify({ estate: 'faithnet.estate', chainId: 34348, factory: dep.agentAccountFactory, identities: people }, null, 2) + '\n');
writeFileSync('/tmp/isl-faithchain-deployments.json', JSON.stringify({ ...dep, chainId: 34348 }, null, 2) + '\n');
console.log('Prepared public identity manifest. Private custodian keys remain in the specified mode-0600 file.');
