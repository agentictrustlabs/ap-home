/**
 * Retire demo agents from a person's list — the accumulated ones, not the real ones.
 *
 *   npx tsx scripts/forget-demo-agents.mts --handle bob --kind person-treasury --keep 1 [--dry]
 *
 * Creating an agent takes a sentence here, so a demo estate fills up with treasuries somebody made to
 * try something once. This removes them from the person's LIST — the KV projection, its index, and their
 * vault's own record, in that order, using the two removal paths that already exist (`related-orgs`
 * `remove: true` for the projection, `relationships.merge` `remove: true` for the record; the projection
 * re-synthesizes from the record if you do only one, which is the projection behaving correctly).
 *
 * IT DESTROYS NOTHING. The smart agents stay on chain exactly as they are; what changes is whose list
 * they appear in. And it REFUSES any that hold a balance — hiding an account with money in it is not
 * tidying, it is losing it, since an unnamed agent has no name to find it by again.
 */
import { createPublicClient, http, type Address } from 'viem';

const HOME = process.env.HOME_BASE ?? 'https://www.faithnet.me';
const RPC = process.env.RPC_URL ?? 'https://a2a.faithnet.io/rpc';
const USDC = (process.env.MOCK_USDC ?? '0xdaE09066A2cc32f6203605619137dcF01A9B49Ae') as Address;
const arg = (flag: string, dflt = ''): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const HANDLE = arg('--handle', 'bob');
const KIND = arg('--kind', 'person-treasury');
const KEEP = Number(arg('--keep', '1'));
const DRY = process.argv.includes('--dry');

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const pub = createPublicClient({ transport: http(RPC) });
const balanceOf = async (a: string): Promise<bigint> => pub.readContract({
  address: USDC, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf', args: [a as Address],
}) as Promise<bigint>;

const signin = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: HANDLE, client_id: 'demo-jp' }) })) as { homeSession?: string; agent?: string };
if (!signin.homeSession || !signin.agent) throw new Error(`no session for ${HANDLE}`);
const person = signin.agent.toLowerCase();
const auth = { authorization: `Bearer ${signin.homeSession}` };

const all = (((await j(await fetch(`${HOME}/connect/related-orgs`, { headers: auth }))) as { orgs?: Array<{ orgAgent: string; orgName?: string; kind?: string }> }).orgs ?? [])
  .filter((o) => o.kind === KIND);
console.log(`${HANDLE} (${person}) holds ${all.length} × ${KIND}`);

// Keep the NAMED ones first, then the oldest — a named agent is one somebody meant to keep.
const ranked = [...all].sort((a, b) => Number(String(b.orgName ?? '').includes('.')) - Number(String(a.orgName ?? '').includes('.')));
const keep = ranked.slice(0, KEEP);
const candidates = ranked.slice(KEEP);
for (const k of keep) console.log(`  keep   ${k.orgName || '(unnamed)'} ${k.orgAgent}`);

let forgotten = 0, skipped = 0;
for (const o of candidates) {
  const held = await balanceOf(o.orgAgent).catch(() => 0n);
  if (held > 0n) {
    console.log(`  KEEP   ${o.orgAgent} — holds ${Number(held) / 1e6} USDC, not hiding an account with money in it`);
    skipped++;
    continue;
  }
  if (DRY) { console.log(`  (dry)  would forget ${o.orgAgent}`); continue; }
  const fromList = await j(await fetch(`${HOME}/connect/related-orgs`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ person, orgAgent: o.orgAgent, remove: true }),
  })) as { ok?: boolean; error?: string };
  // The record second, because it is the authority the projection is rebuilt from — do only the first
  // and the next read puts the row straight back.
  const fromRecord = await fetch(`${HOME}/a2a/interactions/${person}/relationships.merge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: signin.homeSession, entry: { org: o.orgAgent.toLowerCase() }, remove: true }),
  }).then((r) => r.ok).catch(() => false);
  console.log(`  forget ${o.orgAgent} — list=${fromList.ok === true} record=${fromRecord}${fromList.error ? ` (${fromList.error})` : ''}`);
  if (fromList.ok && fromRecord) forgotten++;
}

const after = (((await j(await fetch(`${HOME}/connect/related-orgs`, { headers: auth }))) as { orgs?: Array<{ kind?: string }> }).orgs ?? []).filter((o) => o.kind === KIND).length;
console.log(`\n${HANDLE}: ${all.length} → ${after} × ${KIND} (${forgotten} forgotten, ${skipped} kept for holding funds)`);
