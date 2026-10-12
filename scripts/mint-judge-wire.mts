/**
 * THE JUDGE'S SIGNING WIRE — spec 438 §5: a mechanical evaluator signs with a session key under a wire from its
 * own Smart Agent, pinned to ONE method, `assessment.issue`, and to itself as the only target. A wire that may do
 * anything is not an assessment wire, and the runtime refuses it as one.
 *
 *   npx tsx scripts/mint-judge-wire.mts <judge 0x…> [--custodian demo-admin] [--days 365]
 *
 * The key is GENERATED here and written to `.judge.local` (gitignored, 0600) with the wire beside it. It is a
 * delegate, never an identity: the judge IS its Smart Agent, and revoking this wire on chain stops the key
 * instantly without touching a secret. The custodian signs the delegation digest through the Home with their own
 * credential (`persona-sign`); the judge's account validates it by ERC-1271, so nothing is approved on chain and
 * nothing is spent. Re-running mints a FRESH key and wire; the old ones stay valid until they expire or are revoked.
 */
import { buildCaveat, encodeAllowedTargetsTerms, encodeAllowedMethodsTerms, encodeTimestampTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { skillSelector } from '@agenticprimitives/a2a';
import { CONTRACTS } from '@agenticprimitives/contracts/deployments/faithchain';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, chmodSync } from 'node:fs';
import type { Address, Hex } from 'viem';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const argv = process.argv.slice(2);
const judge = (argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? '').toLowerCase() as Address;
const custodian = argv.includes('--custodian') ? argv[argv.indexOf('--custodian') + 1]! : 'demo-admin';
const days = argv.includes('--days') ? Number(argv[argv.indexOf('--days') + 1]) : 365;
if (!judge) { console.error('usage: mint-judge-wire.mts <judge 0x…> [--custodian handle] [--days n]'); process.exit(2); }

const j = async (r: Response): Promise<Record<string, unknown>> => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
const me = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: custodian, client_id: 'demo-web' }) }));
if (!me.homeSession) throw new Error(`no session for ${custodian}`);
const sign = async (digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.homeSession as string}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(`persona-sign: ${JSON.stringify(b).slice(0, 160)}`);
  return b.signature as Hex;
};

const key = generatePrivateKey();
const signer = privateKeyToAccount(key);
const validUntil = Math.floor(Date.now() / 1000) + days * 86_400;
let salt = 0n; for (const b of crypto.getRandomValues(new Uint8Array(16))) salt = (salt << 8n) | BigInt(b);
const d: Delegation = {
  delegator: judge, delegate: signer.address.toLowerCase() as Address, authority: ROOT_AUTHORITY, salt, signature: '0x',
  caveats: [
    buildCaveat(CONTRACTS.timestampEnforcer as Address, encodeTimestampTerms(0, validUntil)),
    // NO VALUE CAVEAT, on purpose. A judgment spends nothing, and the off-chain caveat evaluator refuses a value
    // caveat it is handed no value for ("context-required") rather than treat it as inert — the first wire minted
    // here carried value(0) out of habit and every judgment was refused for it. Target + method + window is the
    // whole of what an assessment wire pins.
    // The judge acts only FOR ITSELF, and only to issue assessments. Both pins are what the runtime checks.
    buildCaveat(CONTRACTS.allowedTargetsEnforcer as Address, encodeAllowedTargetsTerms([judge])),
    buildCaveat(CONTRACTS.allowedMethodsEnforcer as Address, encodeAllowedMethodsTerms([skillSelector('assessment.issue')])),
  ],
};
d.signature = await sign(hashDelegation(d, CONTRACTS.chainId, CONTRACTS.delegationManager as Address));
const wire = { ...d, salt: d.salt.toString() };
const out = `# faithnet judge — a DELEGATE key and the wire it signs under. Never an identity. 0600, gitignored.\nJUDGE_SA=${judge}\nJUDGE_KEY=${key}\nJUDGE_WIRE='${JSON.stringify(wire)}'\n`;
writeFileSync('.judge.local', out); chmodSync('.judge.local', 0o600);
console.log(`minted: ${judge} → ${signer.address} pinned to assessment.issue, until ${new Date(validUntil * 1000).toISOString().slice(0, 10)} → .judge.local`);
