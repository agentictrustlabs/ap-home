/**
 * RETIRE LINKS FROM A PERSON'S TREE — the authoritative record first, then the Home's projection.
 *
 *   npx tsx scripts/retire-links.mts <handle> [--as <persona-sa>] <agent>... [--apply]
 *
 * Without --apply it only SAYS which of the named agents the person's tree holds (a dry run). With --apply, for each
 * one held: `relationships.merge { entry: { org }, remove: true }` on the person's own InteractionsDO (the vault
 * relationships.data — the record), then `POST /connect/related-orgs { orgAgent, remove: true }` (the KV projection;
 * related-orgs.ts says to do both, in that order, or the next read re-synthesizes the row from the record).
 * Retiring a link changes nothing on chain and deletes no agent: the person simply stops holding it.
 * `--as <persona-sa>` signs in as a character the custodian holds (demo-signin { sa, as }).
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asIdx = args.indexOf('--as');
const as = asIdx >= 0 ? args[asIdx + 1]!.toLowerCase() : null;
const rest = args.filter((a, i) => a !== '--apply' && (asIdx < 0 || (i !== asIdx && i !== asIdx + 1)));
const [handle, ...agents] = rest;
if (!handle || agents.length === 0 || agents.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))) {
  console.error('usage: retire-links.mts <handle> [--as <persona-sa>] <agent>... [--apply]'); process.exit(2);
}
const j = async (r: Response): Promise<any> => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

let si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
if (as) si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sa: si.agent, as, client_id: 'demo-web' }) }));
const token: string | undefined = si.homeSession; const person = String(si.agent ?? '').toLowerCase();
if (!token || !person) throw new Error(`sign-in failed: ${JSON.stringify(si).slice(0, 200)}`);
const rows = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${token}` } }))).orgs ?? []) as Array<{ orgAgent: string; orgName?: string; relationship?: string; purpose?: string }>;
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)).token as string; const cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0];

console.log(`${handle}${as ? ` as ${as}` : ''} — ${person} holds ${rows.length} link(s)`);
for (const a of agents.map((x) => x.toLowerCase())) {
  const held = rows.filter((r) => r.orgAgent.toLowerCase() === a);
  if (!held.length) { console.log(`  ${a}: not held`); continue; }
  console.log(`  ${a}: held — ${held.map((r) => `${r.orgName ?? '?'} (${r.relationship ?? '?'}, ${r.purpose ?? '?'})`).join('; ')}`);
  if (!apply) continue;
  const rec = await j(await fetch(`${HOME}/a2a/interactions/${person}/relationships.merge`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: HOME, cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ session: token, entry: { org: a }, remove: true }),
  }));
  const kv = await j(await fetch(`${HOME}/connect/related-orgs`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ person, orgAgent: a, remove: true }),
  }));
  console.log(`    record: ${rec.ok === false || rec.error ? `✗ ${rec.error ?? JSON.stringify(rec).slice(0, 120)}` : '✓ removed'} · projection: ${kv.ok ? `✓ ${kv.removed ? 'removed' : 'absent'}` : `✗ ${kv.error ?? JSON.stringify(kv).slice(0, 120)}`}`);
}
