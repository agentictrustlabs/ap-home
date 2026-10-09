/**
 * Issue a SELF-HOSTED agent's READ WIRE to this Home — spec 433 W2, the last birthright of a service that keeps its runs at
 * its own host (`service-agent-birthrights.md`): a delegation FROM the agent TO the Home runtime's interactions-session key,
 * pinned to `harness.read` and nothing else, a year long, signed by the steward as the agent's custodian (persona-sign — the
 * SAME signature its storage grant carries: a script-chartered service's Smart Agent accepts its custodian's EOA under
 * ERC-1271). The runtime verifies it the way the host will and keeps it on the agent's object; from then on the steward's
 * Activities page reads the agent's runs at its host THROUGH this Home, under the agent's own wire — never under a session
 * the host could not verify.
 *
 *   npx tsx scripts/issue-self-host-read-wire.mts scripture-resolver.svc --by ruth
 *   npx tsx scripts/issue-self-host-read-wire.mts 0x3064…90b2 --by ruth --days 365
 *
 * Revoke on chain like any delegation of the agent's; re-run after a rotation (spec 410 §1 re-approves standing wires).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { buildCaveat, encodeAllowedMethodsTerms, encodeTimestampTerms, hashDelegation, ROOT_AUTHORITY, type Delegation } from '@agenticprimitives/delegation';
import { skillSelector } from '@agenticprimitives/a2a';
import { CHAIN_ID, CONTRACTS } from '../apps/home/src/lib/chain';
import { toWire } from '../apps/home/src/lib/delegation';

/** service-host's `HARNESS_READ_SKILL` — the root workspace does not depend on service-host, so the literal lives here. */
const HARNESS_READ_SKILL = 'harness.read';
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : undefined;
const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 365;
if (!target || !by) { console.error('usage: issue-self-host-read-wire.mts <address|name> --by <steward handle> [--days 365]'); process.exit(2); }
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

function resolveTarget(t: string): { address: string; label: string } {
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { address: t.toLowerCase(), label: t.toLowerCase() };
  for (const f of readdirSync('demo').filter((x) => x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(`demo/${f}`, 'utf8')) as Record<string, { name?: string; sa?: string }>;
    for (const v of Object.values(doc)) if (v && typeof v === 'object' && v.name === t && typeof v.sa === 'string') return { address: v.sa.toLowerCase(), label: `${t} (${v.sa.toLowerCase()})` };
  }
  throw new Error(`${t} is neither an address nor a name in demo/*.json`);
}
const who = resolveTarget(target);

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: by, client_id: 'demo-jp' }) }));
const token: string = signin.homeSession;
if (!token) throw new Error(`no session for ${by}`);
const sign = async (digest: string): Promise<`0x${string}`> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
  return b.signature;
};

// The delegate: this Home runtime's interactions-session key (the key that will sign each read's assertion).
const key = await j(await fetch(`${HOME}/a2a/agent/interactions-session-key`));
if (!key.ok || !key.address) throw new Error(`the runtime publishes no interactions-session key: ${JSON.stringify(key).slice(0, 160)}`);
const delegate = String(key.address).toLowerCase() as `0x${string}`;

const validUntil = Math.floor(Date.now() / 1000) + days * 86_400;
const bytes = crypto.getRandomValues(new Uint8Array(16));
let salt = 0n; for (const b of bytes) salt = (salt << 8n) | BigInt(b);
const d: Delegation = {
  delegator: who.address as `0x${string}`, delegate, authority: ROOT_AUTHORITY,
  caveats: [
    buildCaveat(CONTRACTS.timestampEnforcer, encodeTimestampTerms(0, validUntil)),
    buildCaveat(CONTRACTS.allowedMethodsEnforcer, encodeAllowedMethodsTerms([skillSelector(HARNESS_READ_SKILL)])),
  ],
  salt, signature: '0x',
};
d.signature = await sign(hashDelegation(d, CHAIN_ID, CONTRACTS.delegationManager));

const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const res = await j(await fetch(`${HOME}/a2a/self-host/wire`, { method: 'POST', headers: H, body: JSON.stringify({ session: token, agent: who.address, wire: toWire(d) }) }));
console.log(`${who.label} → read wire to ${delegate} (${HARNESS_READ_SKILL}, ${days} days) by ${by}: ${JSON.stringify(res).slice(0, 200)}`);
if (!res.ok) process.exit(1);
