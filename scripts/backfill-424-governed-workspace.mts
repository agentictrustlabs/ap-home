/**
 * SPEC 424 W1 BACKFILL — the workspace→org CONTENT read grant for an EXISTING governed workspace, and the
 * `org-workspace:<org>` serving-plane projection every member's `/connect/related-orgs` synthesises from.
 *
 *   npx tsx scripts/backfill-424-governed-workspace.mts <ws-steward-handle> <org-address> <workspace-address> [workspace-name]
 *
 * WHY THIS EXISTS. A workspace CREATED through the Home ceremony mints this grant at create (onboarding.ts
 * §2.3) and writes the projection. A workspace that was PAIRED by a script (`workspace.governor` +
 * `workspace:<ws>` written, but the create ceremony never run — the fieldops realm) has neither. This backfill
 * supplies both, idempotently, for exactly one existing pair, chartering NOTHING.
 *
 * WHAT IT DOES (adopted approach B, spec 424 §2.4 — the grant is workspace→ORG, chained by member→org; NOT a
 * per-member grant):
 *   1. Build the 0x03-approved workspace→org read delegation over the workspace's CONTENT scope ONLY
 *      (`WORKSPACE_CONTENT_SCOPE` — content.catalog, content.artifact.*, the discussion/coordination families;
 *      never workspace.governor, custody, membership or other members' records — §2.1/§4).
 *   2. Approve its digest ON CHAIN as the WORKSPACE (`/harness/authorize`, one userOp the ws-steward signs — the
 *      same path org-create and every act gate use), so the sentinel delegation is valid with no stored signature.
 *   3. Write the `org-workspace:<org>` projection (the ws + the grant) through `/connect/related-orgs`
 *      {governedWorkspace}. The GET then synthesises an enterable `relationship:'member', via:'governed'` row for
 *      every member of the governing org, carrying this grant. The field runtime (W2) chains a member's org
 *      membership onto it and re-verifies at the workspace vault — this projection authorises nothing (ADR-0056).
 *
 * The ws-steward-handle is the persona whose Smart Agent custodies the WORKSPACE (it signs the ws's approveHash)
 * AND stewards the governing ORG (the projection write requires it). For the demo realms that is the operator who
 * ran `provision:fieldops`.
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
// The Home's delegation lib hashes with ITS chain (NEXT_PUBLIC_CHAIN_ID; Base Sepolia by default) — Faithnet is faithchain.
if (/faithnet\.me$/.test(new URL(HOME).host)) process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { buildApprovedOrgReadDelegation, toWire } = await import('../apps/home/src/lib/delegation');
const { WORKSPACE_CONTENT_SCOPE } = await import('../apps/home/src/lib/workspace-governor');
const { MCP_SERVER_ID } = await import('../apps/home/src/lib/inbox-delivery');

const [handle, orgRaw, wsRaw, nameRaw] = process.argv.slice(2);
if (!handle || !/^0x[0-9a-fA-F]{40}$/.test(orgRaw ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(wsRaw ?? '')) {
  throw new Error('usage: backfill-424-governed-workspace.mts <ws-steward-handle> <org-address> <workspace-address> [workspace-name]');
}
const org = orgRaw!.toLowerCase() as `0x${string}`;
const ws = wsRaw!.toLowerCase() as `0x${string}`;
const workspaceName = nameRaw ?? '';

const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const steward = await personaCustodian(HOME, handle);

// 1. The content-scoped workspace→org read grant (0x03 approved; nothing but content — §2.1/§4).
const grant = buildApprovedOrgReadDelegation(ws, org, { server: MCP_SERVER_ID, resources: WORKSPACE_CONTENT_SCOPE });
console.log(`grant ${grant.digest.slice(0, 14)}… : ${ws} → ${org} over ${WORKSPACE_CONTENT_SCOPE.length} content families`);

// 2. Approve the digest ON CHAIN as the workspace — the steward signs the ws's approveHash userOp (0x03 path).
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
const a = await post('/harness/authorize', { session: steward.bearer, delegator: ws, digests: [grant.digest] });
if (a.ok !== true) throw new Error(`authorize build (does ${handle} custody the workspace ${ws}?): ${JSON.stringify(a).slice(0, 300)}`);
const b = await post('/harness/authorize', { session: steward.bearer, delegator: ws, userOp: a.userOp, signature: await steward.signDigest(a.userOpHash) });
if (b.ok !== true) throw new Error(`authorize submit: ${JSON.stringify(b).slice(0, 300)}`);
console.log(`approved on chain as ${ws}`);

// 3. The serving-plane projection the member GET synthesises from (steward of the governor authorises it).
const proj = await j(await fetch(`${HOME}/connect/related-orgs`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${steward.bearer}` },
  body: JSON.stringify({ person: steward.agent, orgAgent: org, governedWorkspace: { workspace: ws, workspaceName, grant: toWire(grant.delegation) } }),
}));
if (proj.ok !== true) throw new Error(`projection not written (does ${handle} steward the org ${org}?): ${JSON.stringify(proj).slice(0, 300)}`);
console.log(`org-workspace:${org} → ${ws} written. A member of ${org} now sees it in /connect/related-orgs with the content grant.`);
