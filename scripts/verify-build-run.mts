/**
 * Spec 398 §9 / ap-build B3 — A BUILD RUN, live (supplied plans; the only model is the Build service's, writing the change).
 *
 *   npx tsx scripts/verify-build-run.mts        (FIXTURE_JSON=… for another estate; roles `org`, `forge`)
 *
 * The organization is the WORKSPACE; its steward, at the organization:
 *   1. asks for a build in the forge repository — `build.run` needs the organization's mandate (authority_required, one
 *      signature); the Build service clones the repository into a sandbox, the model writes whole files, the tests are
 *      RUN and recorded; the reply carries the artifact and PROPOSES the submission (`next: github.pr.open`), and
 *      nothing was pushed or deployed;
 *   2. the artifact is a RECORD in the organization's vault — `build.run.list` reads it back (the declared effect landed);
 *   3. takes the proposed next act: the PR opens on the forge under the organization's connector, its body naming the
 *      build record and the evidence; the files on the branch are the artifact's;
 *   4. the twin: a build with no mandate parks for the WORKSPACE's authority — the service is never called;
 *   5. B2/B4/B5 — a PRIVATE repository builds (the runtime fetched its archive under the workspace's connector; the
 *      artifact says `source: archive`; no credential in any reply); `build.review` shows the recorded evidence APART
 *      from the model's assertion and the forge's checks on the PR; `build.promote` with the WRONG commit is refused
 *      before the forge is touched; with the run and the commit named it merges, and the tuple is the record;
 *   6. the picker's lists: `github.repos.list` names the repositories the connector can WRITE to (the forge among them)
 *      and `github.repo.read` carries the branches, default first — reads, no mandate, no token in any reply.
 * What it does not claim: that the change is good (a reviewer's job, B4) or that anything was promoted (T29).
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
type Next = { capability: string; args: Record<string, unknown>; words: string; why?: string };
type Reply = { kind?: string; error?: string; text?: string; runRef?: string; requirement?: MandateRequirementV1; delegator?: Address; delegate?: Address; alsoApprove?: Array<{ digest: Hex }>; result?: unknown; results?: Array<{ toolId: string; result: unknown }>; next?: Next };
async function approve(runRef: string, rep: Reply): Promise<Reply> {
  if (!rep.requirement || !rep.delegator || !rep.delegate) fail(`nothing to approve on ${runRef}: ${JSON.stringify(rep).slice(0, 200)}`);
  if (rep.delegator!.toLowerCase() !== org) fail(`the mandate asked is ${rep.delegator}'s, not the workspace's (${org}) — a build is the WORKSPACE's act`);
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
async function ask(message: string, toolId: string, args: Record<string, unknown>, act = false): Promise<{ reply: Reply; result: Record<string, unknown> }> {
  let r = (await post('/harness/ask', { session: steward.bearer, addressee: org, message, plan: { steps: [{ toolId, args }] } })).reply as Reply;
  if (r.kind === 'authority_required' && act) r = await approve(r.runRef!, r);
  // A HIGH-risk act (a promotion) climbs the ladder to a second party: the steward standing there signs the approval digest.
  const p = r as Reply & { prompt?: { kind?: string; stepRef?: string; digest?: Hex; signer?: string } };
  if (act && p.kind === 'prompt' && p.prompt?.kind === 'signature' && p.prompt.digest && p.prompt.stepRef) {
    r = (await post('/harness/ask', { session: steward.bearer, addressee: org, runRef: p.runRef, supplied: [{ stepRef: p.prompt.stepRef, signature: { digest: p.prompt.digest, signer: steward.agent.toLowerCase(), signature: await steward.signDigest(p.prompt.digest) } }] })).reply as Reply;
  }
  const result = (r.results ?? []).find((x) => x.toolId === toolId)?.result as Record<string, unknown> | undefined;
  return { reply: r, result: result ?? (r.result as Record<string, unknown> | undefined) ?? {} };
}
const nonce = Date.now().toString(36);
console.log(`── build · ${F.repo} · workspace ${fx.org.handle} ${org} · steward ${fx.people.steward} ──`);

// ── 4 first (cheap): the twin — without the WORKSPACE's mandate nothing is built; the service is never called ──
const bare = await ask(`in ${F.repo} add a greeting (${nonce})`, 'build.run', { workspace: fx.org.handle, repository: F.repo, task: `a greeting (${nonce})` });
if (bare.reply.kind !== 'authority_required') fail(`a build without a mandate did not park for authority: ${JSON.stringify(bare.reply).slice(0, 300)}`);
if (bare.reply.delegator?.toLowerCase() !== org) fail(`the mandate asked is ${bare.reply.delegator}'s, not the workspace's`);
console.log(`  twin: a build with no mandate → authority_required of the workspace (${fx.org.handle}); nothing built`);

// ── 5. the picker's lists — what the Build screen's dropdowns are made of ──
const repos = await ask('which repositories can we build in', 'github.repos.list', { holder: fx.org.handle });
const rl = repos.result as { repositories?: Array<{ repo: string; defaultBranch: string }>; total?: number };
if (repos.reply.kind !== 'answer' || !rl.repositories?.some((r) => r.repo.toLowerCase() === F.repo.toLowerCase())) fail(`the connector's repositories do not list the forge ${F.repo}: ${JSON.stringify(repos.reply).slice(0, 300)}`);
if (/gh[posr]_[A-Za-z0-9]{10,}/.test(JSON.stringify(repos.reply))) fail('a token appeared in the repositories reply');
const br = await ask(`what branches does ${F.repo} have`, 'github.repo.read', { holder: fx.org.handle, repo: F.repo });
const bl = br.result as { defaultBranch?: string; branches?: string[] };
if (!bl.branches?.length || bl.branches[0] !== bl.defaultBranch) fail(`the repository read carries no branches (default first): ${JSON.stringify(br.result).slice(0, 300)}`);
console.log(`  picker: ${rl.total} repositor${rl.total === 1 ? 'y' : 'ies'} the connector can write to (${F.repo} among them) · ${F.repo}: ${bl.branches!.length} branch(es), default ${bl.defaultBranch}`);

// ── 1. the build, under the workspace's mandate ──
const task = `add notes/build-${nonce}.md — a short markdown note titled "Build ${nonce}" saying this file was written by a build run in a sandbox and lists two things a reviewer should check`;
const built = await ask(`in ${F.repo} ${task}`, 'build.run', { workspace: fx.org.handle, repository: F.repo, task }, true);
if (built.reply.kind !== 'done' && built.reply.kind !== 'answer') fail(`the build did not complete: ${JSON.stringify(built.reply).slice(0, 400)}`);
const b = built.result as { built?: boolean; record?: string; artifact?: { runId: string; files: Array<{ path: string; content: string }>; evidence: { command: string; exitCode: number; ran: boolean }; model: string; digest: string; sandbox?: { totalMs: number } }; next?: Next };
if (!b.built || !b.artifact?.files?.length || !b.record) fail(`no artifact in the result: ${JSON.stringify(built.result).slice(0, 400)}`);
if (!b.artifact!.evidence?.ran || typeof b.artifact!.evidence.exitCode !== 'number') fail('the artifact carries no RECORDED evidence (command + exit code)');
const next = built.reply.next ?? b.next;
if (!next || next.capability !== 'github.pr.open' || !Array.isArray(next.args.files)) fail(`the reply does not propose the submission (next: github.pr.open with the files): ${JSON.stringify(built.reply).slice(0, 300)}`);
const text = JSON.stringify(built.reply);
if (/deployed|merged|tests pass(ed)?\b/i.test(text) && !/exited/.test(text)) fail(`the reply asserts what was not done: ${text.slice(0, 300)}`);
console.log(`  built: ${b.artifact!.runId} · ${b.artifact!.files.map((f) => f.path).join(', ')} · evidence \`${b.artifact!.evidence.command.split(';').pop()?.trim()}\` exit ${b.artifact!.evidence.exitCode} · ${b.artifact!.model} · ${b.artifact!.sandbox?.totalMs ?? '?'} ms · record ${b.record}`);
console.log(`  next → ${next!.capability}: "${next!.words}"`);

// ── 2. the record in the workspace's vault (the declared effect) ──
const listed = await ask(`what has been built for ${fx.org.handle}`, 'build.run.list', { workspace: fx.org.handle, repository: F.repo });
const runs = ((listed.result as { runs?: Array<{ runId: string; record: string; evidence: { exitCode: number } }> }).runs ?? []);
const mine = runs.find((r) => r.runId === b.artifact!.runId);
if (!mine) fail(`the build is not in the workspace's records: ${JSON.stringify(listed.result).slice(0, 300)}`);
console.log(`  recorded: ${mine!.record} among ${runs.length} run(s) in ${fx.org.handle}'s vault`);

// ── 3. the proposed submission: the PR under the forge connector ──
const opened = await ask(next!.words, 'github.pr.open', { ...next!.args, holder: fx.org.handle }, true);
const pr = opened.result as { opened?: boolean; number?: number; url?: string; boundTo?: { intentDigest: string; runRef: string } };
if (!pr.opened || !pr.number) fail(`the pull request did not open: ${JSON.stringify(opened.reply).slice(0, 400)}`);
const evidence = await ask(`is pull request ${pr.number} in ${F.repo} ready`, 'github.pr.read', { repo: F.repo, number: pr.number, holder: fx.org.handle });
const ev = evidence.result as { body?: string; title?: string; files?: unknown[] };
const body = String(ev.body ?? (evidence.result as { pullRequest?: { body?: string } }).pullRequest?.body ?? '');
if (body && !body.includes(b.record!)) fail(`the PR body does not name the build record ${b.record}: ${body.slice(0, 200)}`);
console.log(`  submitted: #${pr.number} ${pr.url} — the body names ${b.record}${body ? '' : ' (body not read back by github.pr.read; the opener wrote it)'}`);

// ── 5. B2 · B4 · B5 on the PRIVATE repository ──
if (F.privateRepo) {
  const ptask = `add notes/private-${nonce}.md — a short note titled "Private build ${nonce}" saying this repository is private and its archive reached the sandbox without a credential`;
  const pb = await ask(`in ${F.privateRepo} ${ptask}`, 'build.run', { workspace: fx.org.handle, repository: F.privateRepo, task: ptask }, true);
  const pr2 = pb.result as { built?: boolean; source?: string; baseCommit?: string; artifact?: { runId: string; files: Array<{ path: string; content: string }> }; refused?: string };
  if (!pr2.built || pr2.source !== 'archive' || !pr2.baseCommit) fail(`the private repository did not build from an archive: ${JSON.stringify(pb.reply).slice(0, 400)}`);
  if (/gh[posr]_[A-Za-z0-9]{10,}/.test(JSON.stringify(pb.reply))) fail('a credential appeared in the build reply');
  console.log(`  B2: ${F.privateRepo} built from an ARCHIVE fetched under the connector (base ${pr2.baseCommit.slice(0, 10)}) · run ${pr2.artifact!.runId}`);
  const pnext = pb.reply.next ?? (pb.result as { next?: Next }).next;
  const popened = await ask(pnext!.words, 'github.pr.open', { ...pnext!.args, holder: fx.org.handle }, true);
  const ppr = popened.result as { opened?: boolean; number?: number };
  if (!ppr.opened || !ppr.number) fail(`the private PR did not open: ${JSON.stringify(popened.reply).slice(0, 300)}`);
  // B4 — review: evidence apart from assertion; the forge's checks
  const rv = await ask(`review build ${pr2.artifact!.runId}`, 'build.review', { workspace: fx.org.handle, runId: pr2.artifact!.runId });
  const rr = rv.result as { evidence?: { recorded: boolean; exitCode: number }; assertion?: { note: string }; pullRequest?: { number: number; headSha: string; checksVerdict: string }; ready?: boolean };
  if (!rr.evidence?.recorded || !rr.assertion?.note || rr.pullRequest?.number !== ppr.number || !rr.pullRequest.headSha) fail(`the review did not carry evidence, assertion and the PR: ${JSON.stringify(rv.result).slice(0, 400)}`);
  console.log(`  B4: review — evidence exit ${rr.evidence.exitCode} (recorded) · assertion apart · PR #${rr.pullRequest.number} at ${rr.pullRequest.headSha.slice(0, 10)} · checks ${rr.pullRequest.checksVerdict} · ready ${rr.ready}`);
  // B5 twin — the wrong commit is refused before the forge merges
  const wrong = await ask(`promote build ${pr2.artifact!.runId} at commit 0000000`, 'build.promote', { workspace: fx.org.handle, runId: pr2.artifact!.runId, commit: '0000000' }, true);
  if ((wrong.result as { promoted?: boolean }).promoted || !/tuple names commit/.test(JSON.stringify(wrong.reply))) fail(`the wrong commit was not refused for the tuple: ${JSON.stringify(wrong.reply).slice(0, 300)}`);
  console.log('  B5 twin: a promotion naming another commit → refused (the tuple)');
  // B5 — the promotion, bound to the run and the commit
  const head = rr.pullRequest.headSha.slice(0, 7);
  const promoted = await ask(`promote build ${pr2.artifact!.runId} at commit ${head}`, 'build.promote', { workspace: fx.org.handle, runId: pr2.artifact!.runId, commit: head }, true);
  const pm = promoted.result as { promoted?: boolean; mergeSha?: string; tuple?: { commit: string; environment: string }; record?: string };
  if (!pm.promoted || !pm.record) fail(`the promotion did not land: ${JSON.stringify(promoted.reply).slice(0, 400)}`);
  console.log(`  B5: promoted — merged ${pm.mergeSha?.slice(0, 10)} into ${pm.tuple?.environment} under the tuple (commit ${pm.tuple?.commit.slice(0, 10)}) · record ${pm.record}`);
} else console.log('  B2/B4/B5: skipped — no private forge repository in the fixture (forge.privateRepo)');

console.log(`\n✓ spec 398 §9 / ap-build B3 on ${CHAIN_NAME}: a build run under the workspace's mandate — the repository cloned into a sandbox, the change written by the model, the tests RECORDED, the artifact a record in the workspace's vault, the submission a separate act the reply proposed and the steward signed; nothing deployed; without the mandate nothing built.`);
