/**
 * Spec 400 W2 (B4) — ONE GRANTS SCREEN, live (supplied plans; no model).
 *
 *   npx tsx scripts/verify-grants-admin.mts        (FIXTURE_JSON=… for another estate; roles `org`, `containerRuntime`, `people.*`)
 *
 *   1. the steward audits the ORGANIZATION she stewards: every grant it issued — its members' access delegations among
 *      them (the runtime member's, spec 372 S3b), each with holder, what, digest, and the chain's word;
 *   2. she audits the RUNTIME MEMBER she custodies: its standing grant (the open mandate, W2a) is listed as a `runtime`
 *      grant to its key, live;
 *   3. she REVOKES that standing grant by digest, under the member's mandate (she signs FOR the member as its custodian)
 *      — a transaction; the audit then shows it revoked, and the runtime's next derivation is refused
 *      (`verify-runtime-wake`'s open-mandate path would park again) — then she grants anew so the estate stays live;
 *   4. THE TWIN: a member who stewards nothing here asks for the organization's grants and is refused; an outsider's
 *      audit of the organization is refused.
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian, loadRuntimeMember, buildStandingGrant, recordStandingGrant, saveRuntimeMember, standingEnforcers } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, A2A, skipUnless } from './fixture.mts';

const R = skipUnless(fx.containerRuntime, 'runtime member on a Container (containerRuntime: its .svc and workspace)');
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const nameInfo = async (n: string): Promise<Address> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve at ${HOME}`); return String(r.agent).toLowerCase() as Address; };

const steward = await personaCustodian(HOME, fx.people.steward);
const member = await personaCustodian(HOME, fx.people.member);
const outsider = await personaCustodian(HOME, fx.people.outsider);
const org = await nameInfo(fx.org.handle);
const runtime = await nameInfo(R.member);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown; results?: Array<{ toolId: string; result: unknown }> };
async function approve(addressee: Address, runRef: string, rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve on ${runRef}: ${JSON.stringify(rep).slice(0, 200)}`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement!, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement!.intentDigest as Hex)];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
  const b2 = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, userOp: a.userOp, signature: await steward.signDigest(a.userOpHash as Hex) });
  if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
  mandate.signature = '0x03';
  return ((await post('/harness/ask', { session: steward.bearer, addressee, runRef, presented: { ...mandate, salt: salt.toString() } })).reply ?? {}) as Reply;
}
type Row = { kind: string; holder: string; holderName?: string; what: string; digest: string; revoked: boolean; source: string };
async function audit(who: { bearer: string; agent: Address }, subject?: string): Promise<{ rows: Row[]; refused?: string; raw: Reply }> {
  const r = (await post('/harness/ask', { session: who.bearer, addressee: who.agent, message: subject ? `what has ${subject} granted` : 'what have I granted', plan: { steps: [{ toolId: 'access.grants.audit', args: subject ? { subject } : {} }] } })).reply as Reply;
  const out = (r.results ?? []).find((x) => x.toolId === 'access.grants.audit')?.result as { grants?: Row[]; refused?: string } | undefined;
  return { rows: out?.grants ?? [], ...(out?.refused ? { refused: out.refused } : {}), raw: r };
}
console.log(`── grants · steward ${fx.people.steward} · org ${fx.org.handle} ${org} · runtime ${R.member} ${runtime} ──`);

// ── 1. the organization's grants ──
const orgAudit = await audit(steward, fx.org.handle);
if (orgAudit.refused || orgAudit.raw.kind !== 'answer') fail(`the steward's audit of ${fx.org.handle} did not answer: ${orgAudit.refused ?? JSON.stringify(orgAudit.raw).slice(0, 300)}`);
const memberRow = orgAudit.rows.find((g) => g.kind === 'member' && g.holder === runtime);
if (!memberRow) fail(`${R.member}'s member access grant is not among ${fx.org.handle}'s ${orgAudit.rows.length} grants: ${JSON.stringify(orgAudit.rows.slice(0, 4)).slice(0, 400)}`);
console.log(`  ${fx.org.handle} issued ${orgAudit.rows.length} grant(s) · ${R.member}: ${memberRow!.what} · ${memberRow!.digest.slice(0, 14)}… · ${memberRow!.revoked ? 'revoked' : 'live'}`);
const kinds = [...new Set(orgAudit.rows.map((g) => g.kind))];
console.log(`  kinds: ${kinds.join(', ')}`);

// ── 2. the runtime's grants — its standing grant ──
let rtAudit = await audit(steward, R.member);
// The steward's readable set is derived per ask over every link she holds (many, on this estate); a slow row makes
// one derivation miss — a retry is a re-derivation, not a weaker read.
for (let i = 0; i < 3 && (rtAudit.refused || !rtAudit.rows.length); i++) { console.log(`  … the runtime audit answered ${rtAudit.refused ?? 'nothing'}; re-deriving`); await new Promise((r) => setTimeout(r, 3000)); rtAudit = await audit(steward, R.member); }
const standingRow = rtAudit.rows.find((g) => g.kind === 'runtime' && !g.revoked);
if (!standingRow) fail(`${R.member}'s standing grant is not listed: ${rtAudit.refused ?? JSON.stringify(rtAudit.rows).slice(0, 300)}`);
console.log(`  ${R.member} issued: ${standingRow!.what} to ${standingRow!.holderName ?? standingRow!.holder} · ${standingRow!.digest.slice(0, 14)}… · live`);
const rec = loadRuntimeMember(R.member);
if (rec.standing?.ref.toLowerCase() !== standingRow!.digest.toLowerCase()) fail(`the listed standing grant ${standingRow!.digest.slice(0, 14)}… is not the one the runtime holds (${rec.standing?.ref.slice(0, 14)}…)`);

// ── 3. revoke it by digest, as the member's custodian — a transaction ──
// Asked at HER OWN agent (the grants screen is hers), the holder named: the mandate the harness asks for is the
// MEMBER's (authorityArg holder), which she signs as its custodian — the same way she signs FOR a service anywhere.
let rev = (await post('/harness/ask', { session: steward.bearer, addressee: steward.agent, message: `revoke grant ${standingRow!.digest}`, plan: { steps: [{ toolId: 'access.grant.revoke', args: { digest: standingRow!.digest, holder: runtime } }] } })).reply as Reply;
if (rev.kind === 'authority_required') rev = await approve(steward.agent, rev.runRef!, rev);
if (rev.kind !== 'done' && rev.kind !== 'answer') fail(`the revocation did not go: ${JSON.stringify(rev).slice(0, 300)}`);
const revResult = (rev.result ?? {}) as { revoked?: boolean; transactionHash?: string; tx?: string; note?: string };
if (revResult.revoked !== true) fail(`the revocation reports no revocation: ${JSON.stringify(rev).slice(0, 300)}`);
console.log(`  revoked on chain${revResult.transactionHash ?? revResult.tx ? ` (tx ${String(revResult.transactionHash ?? revResult.tx).slice(0, 18)}…)` : ''}`);
let shown: Row | undefined;
for (let i = 0; i < 6 && !shown?.revoked; i++) { await new Promise((r) => setTimeout(r, 3000)); shown = (await audit(steward, R.member)).rows.find((g) => g.digest.toLowerCase() === standingRow!.digest.toLowerCase()); }
if (!shown?.revoked) fail('after the revocation the audit still lists the standing grant as live');
console.log('  the audit now shows it revoked');

// ── restore: a fresh standing grant, so the runtime keeps its open mandate ──
{
  const contracts = { chainId: C.chainId, delegationManager: DM, timestampEnforcer: C.timestampEnforcer as Address, allowedMethodsEnforcer: C.allowedMethodsEnforcer as Address, valueEnforcer: C.valueEnforcer as Address, allowedTargetsEnforcer: C.allowedTargetsEnforcer as Address, agentRelationship: C.agentRelationship as Address, agentNameRegistry: C.agentNameRegistry as Address, permissionlessSubregistry: C.permissionlessSubregistry as Address, digestBindingEnforcer: C.digestBindingEnforcer as Address };
  const standing = await buildStandingGrant({ member: rec.agent, runtimeKey: rec.address, capabilities: rec.standing!.requirement.actions, ...(rec.standing!.requirement.locations?.length ? { locations: rec.standing!.requirement.locations as Address[] } : {}), validForSeconds: Math.max(rec.standing!.requirement.validUntil - Math.floor(Date.now() / 1000), 3600), enforcers: standingEnforcers(contracts), chainId: C.chainId, delegationManager: DM, signDigest: steward.signDigest });
  saveRuntimeMember({ ...rec, standing });
  const links = ((await j(await fetch(`${HOME}/connect/related-orgs?surface=any`, { headers: { authorization: `Bearer ${steward.bearer}` } }))).orgs ?? []) as Array<{ orgAgent: string; relationship?: string; stewardshipDelegation?: unknown }>;
  const stewardship = links.find((l) => l.orgAgent.toLowerCase() === runtime && l.relationship === 'steward')?.stewardshipDelegation;
  await recordStandingGrant({ a2a: A2A, member: runtime, custodian: steward, ...(stewardship ? { stewardship } : {}), standing, holderName: `${R.member} runtime key` });
  console.log(`  granted anew: ${standing.ref.slice(0, 14)}… (the Container's record must be re-exported for it to derive: ap runtime export → the secret)`);
}

// ── 4. twins ──
const byMember = await audit(member, fx.org.handle);
if (!byMember.refused && byMember.rows.length) fail(`${fx.people.member}, who stewards nothing here, was shown ${fx.org.handle}'s grants`);
const byOutsider = await audit(outsider, fx.org.handle);
if (!byOutsider.refused && byOutsider.rows.length) fail(`${fx.people.outsider} was shown ${fx.org.handle}'s grants`);
console.log(`  twins: ${fx.people.member} → ${byMember.refused ? 'refused' : 'nothing'}; ${fx.people.outsider} → ${byOutsider.refused ? 'refused' : 'nothing'}`);

console.log(`\n✓ spec 400 W2 (B4) on ${CHAIN_NAME}: one screen of every grant — ${fx.org.handle}'s members' access, ${R.member}'s standing grant to its key — revoked by digest under the issuer's mandate (a transaction the audit then reflects); a non-steward and an outsider are refused.`);
