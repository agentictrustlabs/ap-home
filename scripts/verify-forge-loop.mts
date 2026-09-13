/**
 * Spec 400 W3 + W4 — THE REVIEW LOOP ON A FORGE, live (supplied plans; no model; GitHub is the forge).
 *
 *   npx tsx scripts/verify-forge-loop.mts        (FIXTURE_JSON=… for another estate; roles `org`, `forge`)
 *
 * The organization holds a GitHub connector (a Worker secret keyed by its typed name — the platform's credential; no
 * agent carries it). Its steward, at the organization:
 *   1. READS the repository (a lookup; the connector answers, the token never appears);
 *   2. OPENS A PULL REQUEST for a piece of work — a branch, a file written, a PR whose body names the INTENT this run
 *      acts under and the run — her act under the organization's mandate (one prompt);
 *   3. COMMENTS on it (the review) and READS it back as evidence (its binding, the forge's checks, the reviews);
 *   4. PROMOTES it: the ask names the PR and the intent it was opened under; the mandate she signs is bound to that ask;
 *      the connector merges only because the PR's binding matches — the PR is merged;
 *   5. THE TWIN: a promotion whose ask names ANOTHER intent digest is refused before the forge is touched; a PR opened
 *      by hand (no binding) cannot be promoted at all.
 * What it does not claim: the change is a placeholder file, not code a runtime wrote (that is the Build product, G4).
 */
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { buildDigestBindingCaveat, capabilityHandler, hashDelegation, ROOT_AUTHORITY, type Caveat, type Delegation, type MandateRequirementV1 } from '@agenticprimitives/delegation';
import { personaCustodian } from '@agenticprimitives/runtime-member';
import { fixture as fx, HOME, skipUnless } from './fixture.mts';

const F = skipUnless(fx.forge, 'a forge repository the organization holds a connector for (forge: { repo })');
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'faithchain';
const C = ((await import(`@agenticprimitives/contracts/deployments/${CHAIN_NAME}`)) as { CONTRACTS: Record<string, string> & { chainId: number } }).CONTRACTS;
const DM = C.delegationManager as Address;
const ENF = { delegationManager: DM, timestamp: C.timestampEnforcer, allowedTargets: C.allowedTargetsEnforcer, allowedMethods: C.allowedMethodsEnforcer, value: C.valueEnforcer, payment: C.paymentEnforcer, digestBinding: C.digestBindingEnforcer };
const j = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 250), _status: r.status }; } };
const fail = (m: string): never => { console.error(`\n✗ ${m}`); process.exit(1); };
const nameInfo = async (n: string): Promise<Address> => { const r = await j(await fetch(`${HOME}/connect/name-info?name=${encodeURIComponent(n)}`)); if (!r.exists || !r.agent) fail(`${n} does not resolve at ${HOME}`); return String(r.agent).toLowerCase() as Address; };
const steward = await personaCustodian(HOME, fx.people.steward);
const org = await nameInfo(fx.org.handle);
const csrfRes = await fetch(`${HOME}/a2a/auth/csrf`, { headers: { origin: HOME } });
const csrf = (await j(csrfRes)) as { token?: string };
const H = { 'content-type': 'application/json', origin: HOME, cookie: (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '', 'x-csrf-token': csrf.token ?? '' };
const post = async (path: string, body: unknown) => j(await fetch(`${HOME}/a2a${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) }));
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown; results?: Array<{ toolId: string; result: unknown }> };
async function approve(runRef: string, rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve on ${runRef}: ${JSON.stringify(rep).slice(0, 200)}`);
  const caveats: Caveat[] = [...capabilityHandler.toCaveats(rep.requirement!, ENF as never), buildDigestBindingCaveat(ENF.digestBinding as Address, 'intent', rep.requirement!.intentDigest as Hex)];
  let salt = 0n; for (const b of randomBytes(16)) salt = (salt << 8n) | BigInt(b);
  const mandate: Delegation = { delegator: rep.delegator!, delegate: rep.delegate!, authority: ROOT_AUTHORITY, caveats, salt, signature: '0x' };
  const a = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, digests: [hashDelegation(mandate, C.chainId, DM), ...(rep.alsoApprove ?? []).map((x) => x.digest)] });
  if (a.ok !== true) fail(`authorize build: ${JSON.stringify(a).slice(0, 300)}`);
  const b2 = await post('/harness/authorize', { session: steward.bearer, delegator: rep.delegator, userOp: a.userOp, signature: await steward.signDigest(a.userOpHash as Hex) });
  if (b2.ok !== true) fail(`authorize submit: ${JSON.stringify(b2).slice(0, 300)}`);
  mandate.signature = '0x03';
  return ((await post('/harness/ask', { session: steward.bearer, addressee: org, runRef, presented: { ...mandate, salt: salt.toString() } })).reply ?? {}) as Reply;
}
/** One ask at the organization with a supplied plan; an act is approved with one signature. */
async function ask(message: string, toolId: string, args: Record<string, unknown>, act = false): Promise<{ reply: Reply; result: Record<string, unknown> }> {
  let r = (await post('/harness/ask', { session: steward.bearer, addressee: org, message, plan: { steps: [{ toolId, args: { ...args, holder: fx.org.handle } }] } })).reply as Reply;
  if (r.kind === 'authority_required' && act) r = await approve(r.runRef!, r);
  // A HIGH-risk act (a promotion) climbs the ladder to a second party: the steward standing there signs the
  // approval digest into the step — the same rung a payment has.
  const p = r as Reply & { prompt?: { kind?: string; stepRef?: string; digest?: Hex } };
  if (act && p.kind === 'prompt' && p.prompt?.kind === 'signature' && p.prompt.digest && p.prompt.stepRef) {
    r = (await post('/harness/ask', { session: steward.bearer, addressee: org, runRef: p.runRef, supplied: [{ stepRef: p.prompt.stepRef, signature: { digest: p.prompt.digest, signer: steward.agent.toLowerCase(), signature: await steward.signDigest(p.prompt.digest) } }] })).reply as Reply;
  }
  const result = (r.results ?? []).find((x) => x.toolId === toolId)?.result as Record<string, unknown> | undefined;
  return { reply: r, result: result ?? (r.result as Record<string, unknown> | undefined) ?? {} };
}
const nonce = Date.now().toString(36);
console.log(`── forge · ${F.repo} · org ${fx.org.handle} ${org} · steward ${fx.people.steward} ──`);

// ── 1. read ──
const read = await ask(`what is in ${F.repo}`, 'github.repo.read', { repo: F.repo });
if (read.reply.kind !== 'answer' || !read.result.defaultBranch) fail(`the repository read did not answer: ${JSON.stringify(read.reply).slice(0, 300)}`);
console.log(`  read: ${read.result.repo} · default ${read.result.defaultBranch} · ${(read.result.openPullRequests as unknown[]).length} open PR(s)`);
if (JSON.stringify(read.reply).includes('ghp_') || JSON.stringify(read.reply).includes('gho_')) fail('a token appeared in a reply');

// ── 2. open a PR bound to this run's intent ──
const branch = `ap/work-${nonce}`;
const opened = await ask(`open a pull request on ${F.repo} for the venue notes (${nonce})`, 'github.pr.open', { repo: F.repo, branch, title: `venue notes (${nonce})`, body: `Work item: the venue notes for the spring retreat.\n\nOpened by ${fx.org.handle}'s agent at its steward's ask.`, files: [{ path: `notes/venue-${nonce}.md`, content: `# Venue notes (${nonce})\n\n- capacity 120\n- kitchen on site\n` }], workItem: `retreat-venue-${nonce}` }, true);
if (opened.reply.kind !== 'done' && opened.reply.kind !== 'answer') fail(`the pull request did not open: ${JSON.stringify(opened.reply).slice(0, 300)}`);
const pr = opened.result as { opened?: boolean; number?: number; url?: string; boundTo?: { intentDigest: string; runRef: string } };
if (!pr.opened || !pr.number || !pr.boundTo) fail(`no pull request in the result: ${JSON.stringify(opened.result).slice(0, 300)}`);
console.log(`  opened #${pr.number} ${pr.url} · bound to intent ${pr.boundTo!.intentDigest.slice(0, 14)}… run ${pr.boundTo!.runRef}`);

// ── 3. review + evidence ──
const commented = await ask(`comment on pull request ${pr.number} in ${F.repo}: reviewed — the capacity matches the registration count`, 'github.pr.comment', { repo: F.repo, number: pr.number, body: `Reviewed by ${fx.org.handle}'s steward through its agent: the capacity matches the registration count. (${nonce})` }, true);
if (!(commented.result as { commented?: boolean }).commented) fail(`the review comment did not post: ${JSON.stringify(commented.reply).slice(0, 300)}`);
const evidence = await ask(`is pull request ${pr.number} in ${F.repo} ready`, 'github.pr.read', { repo: F.repo, number: pr.number });
const ev = evidence.result as { binding?: { intentDigest: string }; checks?: unknown[]; comments?: number; merged?: boolean };
if (ev.binding?.intentDigest !== pr.boundTo!.intentDigest) fail(`the forge's PR does not carry the binding it was opened under: ${JSON.stringify(ev).slice(0, 300)}`);
console.log(`  reviewed · evidence: binding ${ev.binding!.intentDigest.slice(0, 14)}… · ${ev.checks?.length ?? 0} check(s) · ${ev.comments} comment(s) · merged ${ev.merged}`);

// ── 5a. twin first: a promotion naming ANOTHER intent is refused before the forge is touched ──
const wrong = `0x${'e'.repeat(64)}`;
const twin = await ask(`promote pull request #${pr.number} in ${F.repo} opened under ${wrong}`, 'github.pr.merge', { repo: F.repo, number: pr.number, opened: wrong }, true);
const twinText = JSON.stringify(twin.reply);
if ((twin.result as { promoted?: boolean }).promoted) fail('a promotion under another intent went through');
if (!/promotion refused|bound to intent|not for another/i.test(twinText)) fail(`the wrong-intent promotion was not refused for the right reason: ${twinText.slice(0, 300)}`);
console.log(`  twin: a promotion naming another intent → refused (${/promotion refused: the mandate is bound to intent/.test(twinText) ? 'binding mismatch' : 'refused'})`);

// ── 4. promote under a mandate bound to the work ──
const promoted = await ask(`promote pull request #${pr.number} in ${F.repo} opened under ${pr.boundTo!.intentDigest}`, 'github.pr.merge', { repo: F.repo, number: pr.number, opened: pr.boundTo!.intentDigest }, true);
const pm = promoted.result as { promoted?: boolean; merged?: boolean; sha?: string; promotedUnder?: string };
if (!pm.promoted || !pm.merged) fail(`the promotion did not merge: ${JSON.stringify(promoted.reply).slice(0, 400)}`);
console.log(`  promoted: merged ${pm.sha?.slice(0, 10)} · the promotion's own intent ${pm.promotedUnder?.slice(0, 14)}… names the opening intent`);
const after = await ask(`is pull request ${pr.number} in ${F.repo} merged`, 'github.pr.read', { repo: F.repo, number: pr.number });
if (!(after.result as { merged?: boolean }).merged) fail('the forge does not show the PR merged');

console.log(`\n✓ spec 400 W3/W4 on ${CHAIN_NAME}: the review loop on GitHub — read, a PR opened under the organization's mandate and bound to the run's intent, reviewed, read as evidence, and PROMOTED under a mandate bound to that intent; a promotion naming another intent refused; the credential never left the platform.`);
