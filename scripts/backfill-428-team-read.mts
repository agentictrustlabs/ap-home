/**
 * SPEC 428 W1 BACKFILL — a team's team→org CONTENT read grant, and the `org-teams:<org>` projection the organization's
 * stewards' `/connect/related-orgs` synthesises from.
 *
 *   npx tsx scripts/backfill-428-team-read.mts <team-custodian-handle> [--as <persona-sa>] <org-steward-handle> <org> <team> [team-name]
 *
 * 1. Build the 0x03-approved team→org read delegation over the team's CONTENT only (`GOVERNED_CONTENT_SCOPE`:
 *    content.catalog, content.artifact.*, the discussion/coordination families — never custody, membership,
 *    relationships, the playbook or a member's private records; spec 428 D2).
 * 2. Approve its digest ON CHAIN AS THE TEAM (`/harness/authorize`, one userOp the team's custodian signs — D5: only
 *    the team can grant a read of itself).
 * 3. Write the team into `org-teams:<org>` through `/connect/related-orgs { governedTeam }` as a STEWARD of the org.
 *    The GET then synthesises a `via:'governed'` row carrying the grant for every steward of the org who is not on the
 *    team; the field runtime presents it to the team's vault, which re-verifies it. The projection authorises nothing.
 *
 * The two handles may be the same person (the custodian of the team also stewards the org) or two people.
 * `--as <persona-sa>` signs as a character the team-custodian handle holds (demo-signin { sa, as }).
 * Idempotent in effect: re-running mints and approves a fresh grant and replaces the team's projection entry.
 */
const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
if (/faithnet\.me$/.test(new URL(HOME).host)) process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { buildApprovedOrgReadDelegation, toWire } = await import('../apps/home/src/lib/delegation');
const { GOVERNED_CONTENT_SCOPE } = await import('../apps/home/src/lib/workspace-governor');
const { MCP_SERVER_ID } = await import('../apps/home/src/lib/inbox-delivery');

const argv = process.argv.slice(2);
const asIdx = argv.indexOf('--as');
const as = asIdx >= 0 ? argv[asIdx + 1]!.toLowerCase() : null;
const pos = argv.filter((_, i) => asIdx < 0 || (i !== asIdx && i !== asIdx + 1));
const [teamHandle, orgHandle, orgRaw, teamRaw, ...nameParts] = pos;
const isAddr = (x?: string) => /^0x[0-9a-fA-F]{40}$/.test(x ?? '');
if (!teamHandle || !orgHandle || !isAddr(orgRaw) || !isAddr(teamRaw)) {
  throw new Error('usage: backfill-428-team-read.mts <team-custodian-handle> [--as <persona-sa>] <org-steward-handle> <org> <team> [team-name]');
}
const org = orgRaw!.toLowerCase() as `0x${string}`;
const team = teamRaw!.toLowerCase() as `0x${string}`;
const teamName = nameParts.join(' ');
const j = async (r: Response): Promise<any> => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };

async function signIn(handle: string, persona: string | null) {
  let si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, client_id: 'demo-web' }) }));
  if (persona) si = await j(await fetch(`${HOME}/connect/demo-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sa: si.agent, as: persona, client_id: 'demo-web' }) }));
  if (!si.homeSession) throw new Error(`${handle}${persona ? ` as ${persona}` : ''} could not sign in: ${JSON.stringify(si).slice(0, 160)}`);
  const bearer = String(si.homeSession);
  return {
    bearer, agent: String(si.agent).toLowerCase(),
    signDigest: async (digest: string): Promise<string> => {
      const b = await j(await fetch(`${HOME}/connect/persona-sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ digest }) }));
      if (!b.signature) throw new Error(`persona-sign refused: ${JSON.stringify(b).slice(0, 160)}`);
      return b.signature;
    },
  };
}

const custodian = await signIn(teamHandle, as);
const orgSteward = orgHandle === teamHandle && !as ? custodian : await signIn(orgHandle, null);

// 1. The content-scoped team→org read grant.
const grant = buildApprovedOrgReadDelegation(team, org, { server: MCP_SERVER_ID, resources: GOVERNED_CONTENT_SCOPE });
console.log(`grant ${grant.digest.slice(0, 14)}… : ${team} → ${org} over ${GOVERNED_CONTENT_SCOPE.length} content families`);

// 2. Approve it ON CHAIN as the TEAM.
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const a = await post('/harness/authorize', { session: custodian.bearer, delegator: team, digests: [grant.digest] });
if (a.ok !== true) throw new Error(`authorize build (does ${teamHandle}${as ? ` as ${as}` : ''} custody the team ${team}?): ${JSON.stringify(a).slice(0, 300)}`);
const b = await post('/harness/authorize', { session: custodian.bearer, delegator: team, userOp: a.userOp, signature: await custodian.signDigest(a.userOpHash) });
if (b.ok !== true) throw new Error(`authorize submit: ${JSON.stringify(b).slice(0, 300)}`);
console.log(`approved on chain as ${team}`);

// 3. The org→teams projection (a steward of the org writes it).
const proj = await j(await fetch(`${HOME}/connect/related-orgs`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${orgSteward.bearer}` },
  body: JSON.stringify({ person: orgSteward.agent, orgAgent: org, governedTeam: { team, teamName, grant: toWire(grant.delegation) } }),
}));
if (proj.ok !== true) throw new Error(`projection not written (does ${orgHandle} steward the org ${org}?): ${JSON.stringify(proj).slice(0, 300)}`);
console.log(`org-teams:${org} ← ${team} (${teamName || 'unnamed'}). The org's stewards now see it in /connect/related-orgs with the content grant.`);
