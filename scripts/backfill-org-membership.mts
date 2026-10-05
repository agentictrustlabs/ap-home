/**
 * Backfill `org.membership:member:<sa>` for members admitted before the organization recorded them —
 * finding ORG-MEM-1.
 *
 *   npx tsx scripts/backfill-org-membership.mts <orgAddress> <memberHandle...>
 *
 * NOT a data migration in the usual sense: it writes nothing new. Each member's grant to the
 * organization already exists and is already what confers their access; this records the fact the
 * organization was never asked to write down. The write goes through the SAME op admission uses, with
 * the SAME gates — each member records their own membership, presenting their own grant — so a member
 * whose grant does not check out simply is not recorded.
 */
const HOME = process.env.SSO_BASE_URL ?? 'https://www.faithnet.me';
const j = async (r: Response): Promise<Record<string, unknown>> => {
  const t = await r.text();
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { _raw: t.slice(0, 200), _status: r.status }; }
};

const [org, ...handles] = process.argv.slice(2);
if (!org || !handles.length) throw new Error('usage: backfill-org-membership.mts <orgAddress> <memberHandle...>');
const ORG = org.toLowerCase();

// The grants the organization was given, as its steward sees them. This is the ONLY complete roster
// today, which is the finding — reading it here is how the backfill knows whom to record.
const steward = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'alice', client_id: 'demo-jp' }) }));
const rec = await j(await fetch(`${HOME}/connect/received-delegations`, { headers: { authorization: `Bearer ${String(steward.homeSession)}` } }));
const grants = ((rec.received ?? []) as Array<Record<string, unknown>>).filter((r) => String(r.viaOrg).toLowerCase() === ORG);
console.log(`the organization holds ${grants.length} member grants`);

for (const handle of handles) {
  const s = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-jp' }) }));
  const member = String(s.agent ?? '').toLowerCase();
  const grant = grants.find((g) => String(g.orgAgent).toLowerCase() === member);
  if (!grant) { console.log(`  ${handle}: no grant to this organization — not recorded`); continue; }
  const res = await j(await fetch(`${HOME}/connect/org-membership`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${String(s.homeSession)}` },
    body: JSON.stringify({ org: ORG, delegation: grant.delegation, displayName: grant.displayName ?? grant.orgName ?? '' }),
  }));
  // `ok` is the endpoint's OTHER work. `membershipRecorded` is the thing this script exists to do, and
  // the first run of it printed "recorded" four times while writing nothing.
  console.log(`  ${handle} (${member.slice(0, 10)}…): ${
    res.membershipRecorded === true ? 'recorded'
      : `NOT recorded — ${String(res.membershipError ?? JSON.stringify(res)).slice(0, 160)}`}`);
}
