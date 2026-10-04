/**
 * Re-issue the interactions grant of a SCRIPT-CHARTERED agent (a service or an organization whose custodian
 * is a demo persona's EOA) so it carries the CURRENT scope list — spec 391's `vault:run.artifact:*`, or the
 * next widening.
 *
 *   NEXT_PUBLIC_CHAIN_ID=34348 NEXT_PUBLIC_CONTRACTS_JSON="$(cat packages/contracts/deployments-faithchain.json)" \
 *     npx tsx scripts/reissue-service-grant.mts ligonier.svc --by alice
 *     npx tsx scripts/reissue-service-grant.mts 0x38b5…9347 --by alice
 *
 * WHY A SEPARATE SCRIPT. `reissue-interactions-grants.mts` re-signs a PERSON's grant with that person's own
 * key through the Home's persona-sign. A service chartered by a person's Ask (spec 386: ligonier.svc under
 * globalchurch.org) is custodied by that person — its Smart Agent's ERC-1271 accepts its custodian's EOA —
 * so the same signature, made by the steward, re-issues the service's grant. Nothing here widens a scope:
 * it re-signs whatever the Home's `buildInteractionsStruct` currently builds, for a principal that is not
 * the signer. A grant's caveat is fixed at signing; until this runs, the agent's vault refuses the new
 * record types per record (`record_scope_denied`) — honestly, and uselessly.
 *
 * The agent is named by address, or by a name found in `demo/*.faithnet.json` (an operator fixture).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { buildInteractionsGrantForScript } from '../apps/home/src/lib/delegation';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : undefined;
if (!target || !by) { console.error('usage: reissue-service-grant.mts <address|name> --by <steward handle>'); process.exit(2); }

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200) }; } };

/** An address as given, or the SA a demo fixture records under that name. */
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
const sign = async (digest: string): Promise<string> => {
  const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ digest }) }));
  if (!b.signature) throw new Error(b.error ?? 'persona-sign refused');
  return b.signature;
};
const { grant, sessionLeaf } = await buildInteractionsGrantForScript(who.address, sign, async (path) => j(await fetch(`${HOME}/a2a${path}`)));
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0], 'x-csrf-token': csrf.token ?? '' };
const before = await j(await fetch(`${HOME}/a2a/interactions/${who.address}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: token }) }));
const res = await j(await fetch(`${HOME}/a2a/interactions/${who.address}/grant`, { method: 'POST', headers: H, body: JSON.stringify({ delegation: grant, ...(sessionLeaf ? { sessionLeaf } : {}) }) }));
const after = await j(await fetch(`${HOME}/a2a/interactions/${who.address}/status`, { method: 'POST', headers: H, body: JSON.stringify({ session: token }) }));
console.log(`${who.label} by ${by}: before current=${before.current} → grant=${JSON.stringify(res).slice(0, 120)} → after current=${after.current}`);
if (!res.ok) process.exit(1);
