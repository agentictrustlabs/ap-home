// A STANDING PAYMENT WIRE FOR A VISITING AGENT — spec 439 §6's positive half, the resident's consent.
//
// A resident (a steward of a treasury) decides, once, that a named visiting agent may be paid from her treasury up to a
// cap, for thirty days: the SAME act-as-me standing wire a connected client gets (spec 397 §11; apps/home/src/lib/
// act-as-me.ts), with the visitor's own account as the delegate and the payee. When the visitor later asks her agent
// for a payment within those bounds, the run parks `authority_required`; the visitor derives the child mandate for that
// exact intent from this wire (`deriveFromStanding`) and continues; her agent verifies every link before the money moves.
// Nothing here is a payment: it is a standing decision that one is allowed, within bounds, and it is revocable on chain.
//
//   HOME_URL=https://www.faithnet.me npx tsx scripts/issue-visitor-standing-wire.mts --by alice --treasury alice2.treasury \
//     --payee 0x… --cap 10 --out /path/to/standing-wire.json [--asset 0x…]
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseUnits, type Address, type Hex } from 'viem';
import { buildStandingWire, signedStandingWire } from '@agenticprimitives/delegation';
// The Home's chain.ts resolves enforcers from the app's config, which is empty under a script; these are faithchain's
// (Ring 0 deployments-faithchain.json), the same addresses the Home's act-as-me consent uses when it runs in the app.
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 34348);
// --deployment-file <deployments-<chain>.json>: the enforcer set and chain id of ANOTHER chain (W4: a treasury on hopechain
// is bound by hopechain's enforcers, several of which share faithchain's hex and several of which do not). Read by key,
// never copied; without it the constants below are faithchain's, as before.
const PAYMENT_CAPABILITY = 'treasury.payment.execute';
const CONTRACTS = { delegationManager: '0x710cb1bF08C234Df397e0910331e0A29710EF4F7', timestampEnforcer: '0x73A7B878168b7DE48677617179A8bE894f0Dfe96', allowedTargetsEnforcer: '0x2156311097A936de1916a878bF53Bfd43c7b5715', allowedMethodsEnforcer: '0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41', valueEnforcer: '0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975', paymentEnforcer: '0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE', digestBindingEnforcer: '0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1', universalSignatureValidator: '0xeDd56f500325D4701B9985A34e5Fa6EED6716137' } as const;
const depFile = (process.argv.includes('--deployment-file') ? process.argv[process.argv.indexOf('--deployment-file') + 1] : '') ?? '';
const DEP = depFile ? (JSON.parse((await import('node:fs')).readFileSync(depFile, 'utf8')) as Record<string, string | number>) : null;
const EFFECTIVE_CHAIN_ID = DEP ? Number(DEP.chainId) : CHAIN_ID;
const C = DEP ? (Object.fromEntries(Object.keys(CONTRACTS).map((k) => [k, String(DEP[k] ?? '')])) as typeof CONTRACTS) : CONTRACTS;
if (DEP) for (const [k, v] of Object.entries(C)) if (!/^0x[0-9a-fA-F]{40}$/.test(String(v))) { console.error(`${depFile} has no ${k}`); process.exit(1); }

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const by = flag('by'); const treasuryArg = flag('treasury'); const payee = (flag('payee') ?? '').toLowerCase() as Address; const cap = flag('cap'); const out = flag('out');
// THE DELEGATE holds the wire and derives the child (its key signs the child); THE PAYEE is where the money lands. The
// harness refuses an asker naming itself as its own counterparty, so the two are different accounts — the visitor's
// agent and the visitor's treasury-shaped payee.
const delegate = (flag('delegate') ?? payee).toLowerCase() as Address;
const asset = ((flag('asset') ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as Address); // the treasury's payment rail on faithchain (mock USDC, 6 decimals; Ring 0 deployments-faithchain.json#mockUsdc)
// The wire's bounds beyond the per-payment cap: the aggregate over the window and how many redemptions the window
// admits (the package's defaults are the cap itself and ONE per day — right for a person's wire, too tight for a gate
// that runs nightly). Said on the command line, never silently widened.
const aggregate = flag('aggregate'); const redemptions = Number(flag('redemptions') ?? 1); const windowSeconds = Number(flag('window') ?? 86_400);
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
if (!by || !treasuryArg || !/^0x[0-9a-f]{40}$/.test(payee) || !/^0x[0-9a-f]{40}$/.test(delegate) || !cap || !out) { console.error('usage: issue-visitor-standing-wire.mts --by <steward> --treasury <name|0x…> --delegate 0x… --payee 0x… --cap <units> --out <file> [--asset 0x…] [--aggregate <units>] [--redemptions <n>] [--window <seconds>]'); process.exit(1); }
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

// the treasury: a name resolved at the town's naming service, or an address
let treasury = treasuryArg.toLowerCase() as Address;
if (!/^0x[0-9a-f]{40}$/.test(treasury)) {
  const n = await j(await fetch(`https://names.faithnet.io/api/name/${encodeURIComponent(treasuryArg)}`));
  if (n.status !== 'registered' || n.kind !== 'treasury' || !n.agent) { console.error(`${treasuryArg} is not a registered treasury name: ${JSON.stringify(n).slice(0, 160)}`); process.exit(1); }
  treasury = String(n.agent).toLowerCase() as Address;
}
// the steward's session at her Home — persona-sign signs as the treasury's custodian (ERC-1271 under her EOA)
const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession; const person = String(signin.agent ?? signin.smartAgent ?? '').toLowerCase() as Address;
if (!token || !/^0x[0-9a-f]{40}$/.test(person)) { console.error(`no session for ${by} at ${HOME}`); process.exit(1); }
const RPC = process.env.RPC_URL ?? process.env.FEDERATION_RPC_URL ?? 'https://rpc.faithnet.io';
const pc = createPublicClient({ chain: { id: EFFECTIVE_CHAIN_ID, name: 'c', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) });
const sign = async (_delegator: Address, digest: Hex): Promise<Hex> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
  return b.signature as Hex;
};
const maxAmount = parseUnits(cap, 6);
const enforcers = { delegationManager: C.delegationManager, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer } as const;
const { standing: unsigned } = buildStandingWire({ template: 'act-as-me', delegator: treasury, delegate, capability: PAYMENT_CAPABILITY, payment: { payee, asset, maxAmount, maxAggregate: aggregate ? parseUnits(aggregate, 6) : maxAmount, maxRedemptionsPerWindow: redemptions, windowSeconds }, validForSeconds: 60 * 60 * 24 * 30, enforcers: enforcers as never, chainId: EFFECTIVE_CHAIN_ID, delegationManager: C.delegationManager as Address });
const wire = signedStandingWire(unsigned, await sign(treasury, unsigned.ref));
void person;
const VALIDATOR_ABI = [{ type: 'function', name: 'isValidSig', stateMutability: 'view', inputs: [{ name: 'signer', type: 'address' }, { name: 'hash', type: 'bytes32' }, { name: 'sig', type: 'bytes' }], outputs: [{ type: 'bool' }] }] as const;
// A FAILED READ IS NOT A FAILED SIGNATURE. Catching the read into `false` once reported "alice is not its custodian"
// when the only thing wrong was an unkeyed RPC URL (`https://rpc.faithnet.io` without its `?k=`), and the key she had
// signed with was the right one all along. The two outcomes are now said separately.
const verdict = await pc
  .readContract({ address: C.universalSignatureValidator as Address, abi: VALIDATOR_ABI, functionName: 'isValidSig', args: [treasury, wire.ref, String(wire.wire.signature) as Hex] })
  .then((ok) => ({ read: true as const, ok: ok as boolean }))
  .catch((e: unknown) => ({ read: false as const, why: String(e).split('\n')[0].slice(0, 200) }));
if (!verdict.read) { console.error(`the signature could not be CHECKED — the validator read failed at ${RPC}: ${verdict.why}\n  this says nothing about ${by}'s key; set RPC_URL to a reachable, keyed endpoint and run again. nothing written`); process.exit(1); }
if (!verdict.ok) { console.error(`the wire's signature does not verify for the treasury ${treasury} — ${by} is not its custodian? nothing written`); process.exit(1); }
writeFileSync(out, JSON.stringify({ ...wire, issuedBy: by, treasuryName: treasuryArg, capShq: cap, issuedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(`standing wire ${wire.ref}\n  ${treasuryArg} (${treasury}) → delegate ${delegate}: ${PAYMENT_CAPABILITY}, payee ${payee}, up to ${cap} per payment${aggregate ? `, ${aggregate} in aggregate` : ''}, ${redemptions}/${windowSeconds}s, 30 days\n  signed by ${by} as the treasury's custodian; signature verified on chain\n  written ${out} (the visitor's copy — revoke on chain like any delegation of the treasury's)`);
