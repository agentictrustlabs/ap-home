/**
 * RE-ISSUE AN ORGANIZATION'S INTERACTIONS GRANT on Faithnet after a SCOPE WIDENING (spec 322 W3) — the third door of a
 * new vault record (`EFFECT_WRITABLE_RECORDS` · `vault:<key>` in grant-scopes · THIS).
 *
 *   npx tsx scripts/reissue-org-interactions-grant.mts <steward-handle> <org-address>
 *
 * The organization's custodian is its steward's SMART AGENT, so an EOA signature over the grant fails ERC-1271 at the
 * org (what `enable-interactions-at.mts` does for a person). The organization APPROVES the digests instead — the same
 * one-userOp path the Home's one-prompt org-create and every act gate use (`/harness/authorize`: the steward signs the
 * userOp, the org's `approveHash` lands) — and the grant is posted with the approved-hash sentinel (`0x03`).
 */
import { personaCustodian } from '@agenticprimitives/runtime-member';

const HOME = process.env.HOME_URL ?? 'https://www.faithnet.me';
// The Home's delegation lib hashes with ITS chain (NEXT_PUBLIC_CHAIN_ID; Base Sepolia by default) — Faithnet is faithchain.
if (/faithnet\.me$/.test(new URL(HOME).host)) process.env.NEXT_PUBLIC_CHAIN_ID ??= '34348';
const { buildApprovedInteractionsDelegation, buildApprovedSessionDelegation, toWire, ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS, ORG_INTERACTIONS_SESSION_LEAF_LADDER_RUNGS } = await import('../apps/home/src/lib/delegation');
const { MCP_SERVER_ID } = await import('../apps/home/src/lib/inbox-delivery');
const SERVICE = (process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA ?? '0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a') as `0x${string}`;
const [handle, orgRaw] = process.argv.slice(2);
if (!handle || !/^0x[0-9a-fA-F]{40}$/.test(orgRaw ?? '')) throw new Error('usage: reissue-org-interactions-grant.mts <steward-handle> <org-address>');
const org = orgRaw!.toLowerCase() as `0x${string}`;
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 200), _status: r.status }; } };
const steward = await personaCustodian(HOME, handle);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));

const sk = (await j(await fetch(`${HOME}/a2a/agent/interactions-session-key`))) as { ok?: boolean; address?: string };
if (!sk.ok || !sk.address) throw new Error(`no interactions-session key advertised: ${JSON.stringify(sk)}`);
const ix = buildApprovedInteractionsDelegation(org, SERVICE, MCP_SERVER_ID);
// Spec 423 §2.1 route A — a LADDER of approved leaves, windows tiling forward (rung i valid for (i+1)·orgTTL),
// so a live rung exists for rungs·orgTTL without the steward returning. All digests are approved in one userOp.
const leaves = Array.from({ length: ORG_INTERACTIONS_SESSION_LEAF_LADDER_RUNGS }, (_, i) =>
  buildApprovedSessionDelegation(org, sk.address as `0x${string}`, [SERVICE], (i + 1) * ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS)); // spec 408 §2.1
const a = await post('/harness/authorize', { session: steward.bearer, delegator: org, digests: [ix.digest, ...leaves.map((l) => l.digest)] });
if (a.ok !== true) throw new Error(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
const b = await post('/harness/authorize', { session: steward.bearer, delegator: org, userOp: a.userOp, signature: await steward.signDigest(a.userOpHash) });
if (b.ok !== true) throw new Error(`authorize submit: ${JSON.stringify(b).slice(0, 300)}`);
console.log(`approved on chain: grant ${ix.digest.slice(0, 14)}… + ${leaves.length} leaf rung${leaves.length === 1 ? '' : 's'}`);
let g: Record<string, unknown> = {};
for (let i = 0; i < 8; i++) {
  g = await post(`/interactions/${org}/grant`, { delegation: toWire(ix.delegation), sessionLeaves: leaves.map((l) => toWire(l.delegation)) });
  if (g.ok === true) break;
  console.log(`  grant attempt ${i + 1}: ${JSON.stringify(g).slice(0, 140)}`);
  await new Promise((r) => setTimeout(r, 4000));
}
if (g.ok !== true) throw new Error(`grant not stored: ${JSON.stringify(g).slice(0, 300)}`);
const st = (await j(await fetch(`${HOME}/a2a/interactions/${org}/status`))) as { granted?: boolean; current?: boolean; recordScopes?: string[] };
console.log(`${handle} → ${org}: granted=${st.granted} current=${st.current} scopes=${st.recordScopes?.length}`);
