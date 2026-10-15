// THE ANCHORING WIRE — spec 439 §4: the estate's `.registry` service agent is what anchors its roots, and the job
// that does the anchoring holds a DELEGATE key under a wire, never the agent's custody (ADR-0019, the
// service-agent-signing rule).
//
// What this mints: a standing delegation from the registry agent's Smart Agent to one key, pinned to ONE target (the
// EstateProjectionRegistry) and ONE method (`setRoots`), time-bounded, signed by the agent's own custodian. The holder
// of that key redeems it; the DelegationManager executes the call THROUGH the agent's account, so the registry sees
// `msg.sender == the agent` — which is what lets `signerOf(estateId)` be the agent rather than a loose key.
//
// What that buys, concretely: the key the projector holds can anchor this estate's roots and do nothing else, for as
// long as the wire lasts, and the estate ENDS it with one on-chain revocation without touching the agent, its name,
// or anything else it may later be given. A Worker secret that was the signer could do none of that.
//
//   RPC_URL=… npx tsx scripts/issue-anchoring-wire.mts --agent 0x… --delegate 0x… --registry 0x… \
//     --persona demo-admin [--days 90] [--out …/anchoring-wire-<estate>.json]
//   … or CUSTODIAN_KEY_ENV_FILE=…/.estate-impact-agent.local CUSTODIAN_KEY_VAR=A2A_INTERACTIONS_SESSION_PRIVATE_KEY
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCaveat, encodeAllowedMethodsTerms, encodeAllowedTargetsTerms, encodeTimestampTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { createPublicClient, hashMessage, http, toFunctionSelector, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const agent = (arg('agent') ?? '').toLowerCase() as Address;
const delegate = (arg('delegate') ?? '').toLowerCase() as Address;
const registry = (arg('registry') ?? '0xb4E116F5C6915a4f1e649E0877e4a0A7a1c1147b').toLowerCase() as Address;
const days = Number(arg('days') ?? 90); const out = arg('out'); const persona = arg('persona'); const home = arg('home'); const by = arg('by');
if (!/^0x[0-9a-f]{40}$/.test(agent) || !/^0x[0-9a-f]{40}$/.test(delegate) || !out) { console.error('usage: issue-anchoring-wire.mts --agent 0x<registry agent> --delegate 0x<the projector key> --out <file> [--registry 0x…] [--days 90] [--persona <handle>]'); process.exit(1); }
const RPC = process.env.RPC_URL ?? (() => { console.error('RPC_URL is required'); process.exit(1); })();
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
const C = { delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestampEnforcer: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargetsEnforcer: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethodsEnforcer: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', universalSignatureValidator: '0xeDd56f500325D4701B9985A34e5Fa6EED6716137' } as const;

const envFile = process.env.CUSTODIAN_KEY_ENV_FILE ?? ''; const varName = process.env.CUSTODIAN_KEY_VAR ?? 'CUSTODIAN_PRIVATE_KEY';
const fromRoster = persona ? ((JSON.parse(readFileSync('demo/personas.local.json', 'utf8')) as Record<string, { eoaPrivateKey?: string }>)[persona]?.eoaPrivateKey ?? '') : '';
const custodianKey = (fromRoster || process.env.CUSTODIAN_PRIVATE_KEY || (envFile ? (new RegExp(`^${varName}=['"]?(0x[0-9a-fA-F]{64})`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1] ?? '') : '')) as Hex;
// The custodian signs where it lives: at its Home (a persona of that estate — the shape to prefer), or from a key here.
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200) }; } };
let sign: (digest: Hex) => Promise<Hex>; let who: string;
if (home && by) {
  const signin = await j(await fetch(`${home}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
  const token = String(signin.homeSession ?? '');
  if (!token) { console.error(`no session for ${by} at ${home}`); process.exit(1); }
  sign = async (digest) => { const b = await j(await fetch(`${home}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) })); if (!b.signature) throw new Error(String(b.error ?? 'persona-sign refused')); return b.signature as Hex; };
  who = `${by} at ${home}`;
} else {
  if (!/^0x[0-9a-fA-F]{64}$/.test(custodianKey)) { console.error('a custodian is required (--home <url> --by <handle>, --persona <handle>, CUSTODIAN_PRIVATE_KEY, or CUSTODIAN_KEY_ENV_FILE + CUSTODIAN_KEY_VAR)'); process.exit(1); }
  const acct = privateKeyToAccount(custodianKey);
  sign = (digest) => acct.signMessage({ message: { raw: digest } });
  who = acct.address;
}

// ONE TARGET, ONE METHOD, ONE WINDOW. A wire that allowed the registry's other functions would let its holder
// re-register or rotate the signer; a wire with no target would let it call anything the agent can.
const SET_ROOTS = toFunctionSelector('function setRoots(bytes32,bytes32,bytes32,bytes32,uint64)');
const validUntil = Math.floor(Date.now() / 1000) + days * 86_400;
const bytes = crypto.getRandomValues(new Uint8Array(16)); let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
const d: Delegation = {
  delegator: agent, delegate, authority: ROOT_AUTHORITY,
  caveats: [
    buildCaveat(C.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(C.allowedTargetsEnforcer, encodeAllowedTargetsTerms([registry])),
    buildCaveat(C.allowedMethodsEnforcer, encodeAllowedMethodsTerms([SET_ROOTS])),
  ],
  salt, signature: '0x',
};
const digest = hashDelegation(d, CHAIN_ID, C.delegationManager);
// The custodian signs for the agent: the account's ERC-1271 accepts its custodian's signature. Raw first, EIP-191
// second — not a fallback between mechanisms but the two forms a key-held custodian uses here, and the chain says which.
const pc = createPublicClient({ chain: { id: CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) });
const VALIDATOR = [{ type: 'function', name: 'isValidSig', stateMutability: 'view', inputs: [{ name: 's', type: 'address' }, { name: 'h', type: 'bytes32' }, { name: 'sig', type: 'bytes' }], outputs: [{ type: 'bool' }] }] as const;
const check = (sig: Hex, hash: Hex) => pc.readContract({ address: C.universalSignatureValidator, abi: VALIDATOR, functionName: 'isValidSig', args: [agent, hash, sig] }).catch(() => false);
let signature = await sign(digest);
let how = 'EIP-191 over the digest';
if (!(await check(signature, hashMessage({ raw: digest })))) {
  if (await check(signature, digest)) how = 'raw digest';
  else { console.error(`the custodian ${who} does not verify for ${agent} — is it this agent's custodian? nothing written`); process.exit(1); }
}
d.signature = signature;
writeFileSync(out, JSON.stringify({ type: 'ap.anchoring-wire.v1', chainId: CHAIN_ID, delegationManager: C.delegationManager, registry, digest, wire: { ...d, salt: d.salt.toString() }, validUntil, issuedAt: new Date().toISOString(), note: 'the projector redeems this; revoke it on chain to stop it anchoring' }, null, 2), { mode: 0o600 });
console.log(`anchoring wire ${digest}\n  ${agent} → ${delegate}: setRoots on ${registry} only, until ${new Date(validUntil * 1000).toISOString().slice(0, 10)}\n  signed by its custodian ${who} (${how}), verified on chain\n  written ${out}\n  revoke: the agent's custodian calls DelegationManager.revokeDelegation(${digest})`);
