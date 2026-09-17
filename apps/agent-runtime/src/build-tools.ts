// SPEC 398 §9 / ap-build B3 — THE BUILD RUN AS A CAPABILITY. `build.run` is the WORKSPACE's act (`authorityArg:
// workspace` — its steward signs the mandate for THIS task, as the ~/skills contract `build-run` declares): the runtime
// hands the task to the Build service (ap-build's `apps/build-service`, a Worker that owns the sandbox and the model key),
// which clones the repository into a sandbox, has the model write whole files, RUNS the repository's tests and returns the
// artifact. The runtime never runs generated code (T24) and the service never decides who may build (D15 — it verifies a
// bearer, the mandate is verified HERE). What the run leaves is the artifact record in the workspace's vault (the
// declared effect, `packages/harness` discharges it) and a PROPOSED next act: `github.pr.open` with the files — the
// branch and the PR are the forge connector's acts under their own signature, never this one's (spec 367 §6: a branch
// pushed is a submission). Nothing here deploys (T29).
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import type { BuildArtifactRecordV1 } from '@agenticprimitives/harness';
import { GITHUB_PR_OPEN } from './connectors/github-tools.js';
import { intentDigest } from '@agenticprimitives/delegation';
import { githubApi, githubTokenFor, parseRepo, readPullRequest, mergePullRequest, type GithubEnv } from './connectors/github.js';

export const BUILD_RUN = 'build.run' as const;
export const BUILD_RUN_LIST = 'build.run.list' as const;
export const BUILD_REVIEW = 'build.review' as const;
export const BUILD_PROMOTE = 'build.promote' as const;
export const BUILD_ACTS = new Set<string>([BUILD_RUN, BUILD_PROMOTE]);

export interface BuildEnv extends GithubEnv { BUILD_SERVICE_URL?: string; BUILD_SERVICE_TOKEN?: string }

const workspaceArg = { workspace: { type: 'string', description: 'The workspace (organization) the repository is attached to — whose mandate this needs (defaults to the addressee)' } };

export const BUILD_TOOLS: ToolSpec[] = [
  {
    id: BUILD_RUN,
    verbs: ['build', 'implement', 'generate', 'scaffold', 'write the code for', 'make the change in'],
    description: 'RUNS ONE BUILD TASK for a workspace under its mandate: the repository (owner/name, public) is cloned into a sandbox, the task\'s words become whole files written by the model, the repository\'s tests are RUN and recorded, and the artifact (files + test evidence) lands in the workspace\'s vault. Nothing is pushed, opened or deployed — the receipt PROPOSES opening a pull request with the files (github.pr.open). Args: repository (owner/name), task (what to build, in the asker\'s words), base (branch, default main), workItem (optional), workspace.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string', description: 'owner/name' }, task: { type: 'string' }, base: { type: 'string' }, workItem: { type: 'string' }, ...workspaceArg }, required: ['repository', 'task'] },
    // The mandate's resource is the WORKSPACE agent (the repository is attached to it; its name rides in the bound intent).
    capability: { id: BUILD_RUN, action: 'build', resourceArg: 'workspace', authorityArg: 'workspace' },
    risk: 'medium',
    establishes: 'submission',
  },
  {
    id: BUILD_REVIEW,
    answers: ['review the build', 'what did the build change', 'is the build ready', 'show the evidence for the build', 'review build'],
    description: 'REVIEWS one build run (spec 398 §9.4, B4): the files it wrote and the test evidence AS RECORDED (command, exit code, output), kept APART from what the model asserted; and, when a pull request was opened from it, the forge\'s own checks and reviews. Never merges. Args: runId (build-…), workspace.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, ...workspaceArg }, required: ['runId'] },
    establishes: 'lookup',
  },
  {
    id: BUILD_PROMOTE,
    verbs: ['promote the build', 'ship the build', 'land the build', 'promote build'],
    description: 'PROMOTES one build run (spec 398 §9.4, B5): merges the pull request opened from it into the repository\'s default branch — the environment — under a mandate BOUND to the exact tuple: the ask must name the build run AND the commit it lands (from build.review). Refused while the forge\'s checks fail or run, when no pull request was opened from the run, or when the tuple the ask names is not the one on the forge. Leaves a promotion record. Args: runId, commit (the PR head sha from build.review), workspace.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, commit: { type: 'string', description: 'The PR head commit (7+ hex) the promotion is bound to' }, ...workspaceArg }, required: ['runId', 'commit'] },
    capability: { id: BUILD_PROMOTE, action: 'promote', resourceArg: 'workspace', authorityArg: 'workspace' },
    risk: 'high',
    establishes: 'authoritative',
  },
  {
    id: BUILD_RUN_LIST,
    answers: ['what has been built', 'the build runs', 'list the builds', 'recent builds', 'what did the builder make'],
    description: 'READS the workspace\'s build runs — each artifact\'s repository, task, files changed and the recorded test evidence (exit code), newest first. Never builds. Args: workspace, repository (optional filter), max.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, max: { type: 'integer' }, ...workspaceArg } },
    establishes: 'lookup',
  },
];

export interface BuildToolDeps {
  env: BuildEnv;
  resolveName?: (name: string) => Promise<string | null>;
  nameOf?: (address: string) => Promise<string | null>;
  survey?: (subject: string) => Promise<Array<{ recordType: string; updatedAt?: string }>>;
  readRecords?: (subject: string, recordTypes: string[]) => Promise<Record<string, unknown>>;
  readSubjectRecord?: (subject: string, recordType: string) => Promise<unknown>;
  writeSubjectRecord?: (subject: string, recordType: string, record: unknown) => Promise<{ ok: boolean; error?: string }>;
  fetch?: typeof fetch;
}

/** The workspace's promotion record — `build.promotion:<runId>` (`apexec:BuildPromotion`): the exact tuple the steward's
 *  signature was over, and what the forge did. Field names ARE the T-box property names. */
export interface BuildPromotionRecordV1 {
  type: 'ap.build-promotion.v1';
  runId: string;
  workspace: string;
  repository: string;
  /** THE TUPLE (spec 398 §9.4 / T29): commit · config · environment · migration — any change voids the signature. */
  commit: string;
  configDigest: string;
  environment: string;
  migration: string;
  pullRequest: number;
  mergeSha: string | null;
  promotedUnder: string;
  runRef: string;
  promotedAt: string;
}

/** B2 — the repository as bytes, fetched by the RUNTIME under the workspace's connector credential; the credential
 *  never leaves this Worker, and the sandbox receives files, not a remote. GitHub answers the tarball with a 302 to a
 *  pre-signed codeload URL; the second hop carries no header. */
async function archiveOf(env: BuildEnv, f: typeof fetch, token: string, repository: string, base: string): Promise<{ base64: string; commit: string; bytes: number }> {
  const api = githubApi(token, f);
  const head = await api.call<{ sha?: string; message?: string }>('GET', `/repos/${repository}/commits/${encodeURIComponent(base)}`);
  if (!head.ok || !head.data.sha) throw new Error(`the branch ${base} of ${repository} was not read with the workspace's connector: ${head.data?.message ?? head.status}`);
  const first = await f(`https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(base)}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agenticprimitives-connector' }, redirect: 'manual' });
  const location = first.headers.get('location');
  const res = first.status >= 300 && first.status < 400 && location ? await f(location, { redirect: 'follow' }) : first;
  if (!res.ok) throw new Error(`the archive of ${repository}@${base} was not read (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 30_000_000) throw new Error(`${repository} is larger than a build takes as an archive (30 MB)`);
  let s = ''; for (let i = 0; i < buf.byteLength; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(s), commit: head.data.sha, bytes: buf.byteLength };
}

/** Whose workspace: the mandate's delegator for an act, `workspace` for a read, else the addressee. */
async function workspaceOf(deps: BuildToolDeps, args: Record<string, unknown>, presented: { wire?: { delegator?: string } } | null, addressee: string | undefined): Promise<`0x${string}`> {
  const fromMandate = presented?.wire?.delegator;
  const raw = String(args.workspace ?? fromMandate ?? addressee ?? '').trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : '';
  if (!address && raw && deps.resolveName) address = ((await deps.resolveName(raw).catch(() => null)) ?? '').toLowerCase();
  if (!address) throw new Error('which workspace? — name the organization the repository is attached to (workspace)');
  if (fromMandate && fromMandate.toLowerCase() !== address) throw new Error(`the mandate is ${fromMandate}'s, but the workspace asked for is ${address}'s — a build is authorized by the workspace it is for`);
  return address as `0x${string}`;
}

interface ServiceArtifact { type: 'ap.build.artifact.v1'; runId: string; repository: string; base: string; task: string; files: Array<{ path: string; content: string }>; summary: string; evidence: { command: string; exitCode: number; ran: boolean; outputTail: string; durationMs: number }; model: { provider: string; model: string }; sandbox: { image: string; sdk: string; cloneMs: number; totalMs: number }; at: string; workItem?: string }

export function buildInvoker(deps: BuildToolDeps, presented: { wire?: { delegator?: string } } | null, addressee: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const workspace = await workspaceOf(deps, args, presented, addressee);
    switch (toolId) {
      case BUILD_RUN: {
        const { BUILD_SERVICE_URL: url, BUILD_SERVICE_TOKEN: token } = deps.env;
        if (!url || !token) return { refused: 'no Build service is configured on this deployment (BUILD_SERVICE_URL / BUILD_SERVICE_TOKEN) — a build needs a sandbox the operator provides' };
        const repository = String(args.repository ?? '').trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`repository must be owner/name (got "${repository}")`);
        const task = String(args.task ?? '').trim();
        if (!task) throw new Error('what should be built? — the task, in your words');
        const f = deps.fetch ?? fetch;
        // B2 — with the workspace's forge connector, the repository reaches the sandbox as an ARCHIVE this Worker fetched
        // (a private repository builds; the credential never leaves here). Without one, a public repository is cloned.
        const wsName = deps.nameOf ? await deps.nameOf(workspace).catch(() => null) : null;
        const connector = githubTokenFor(deps.env, wsName);
        let archive: { base64: string; commit: string; bytes: number } | null = null;
        if (connector) {
          try { archive = await archiveOf(deps.env, f, connector, repository, typeof args.base === 'string' && args.base ? args.base : 'main'); }
          catch (e) { return { refused: `${e instanceof Error ? e.message : String(e)} — the workspace's connector cannot read it; a public repository builds without one`, workspace, repository, task }; }
        }
        const res = await f(`${url.replace(/\/$/, '')}/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ repository, task, ...(typeof args.base === 'string' && args.base ? { base: args.base } : {}), ...(typeof args.workItem === 'string' && args.workItem ? { workItem: args.workItem } : {}), workspace, ...(archive ? { archive: { base64: archive.base64, commit: archive.commit } } : {}) }) });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; artifact?: ServiceArtifact; error?: string };
        if (!res.ok || !body.ok || !body.artifact) return { refused: `the build did not complete: ${body.error ?? `the Build service answered ${res.status}`}`, workspace, repository, task };
        const a = body.artifact;
        const digest = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(a.files))))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const model = `${a.model.provider}/${a.model.model}`;
        const artifact: Omit<BuildArtifactRecordV1, 'type' | 'workspace' | 'runRef' | 'mandateRef' | 'builtAt'> & { at: string; sandbox: ServiceArtifact['sandbox'] } = { runId: a.runId, repository: a.repository, base: a.base, task: a.task, summary: a.summary, files: a.files, evidence: a.evidence, model, digest, at: a.at, sandbox: a.sandbox, ...(a.workItem ? { workItem: a.workItem } : {}) };
        const tests = a.evidence.command.includes('npm test') ? (a.evidence.exitCode === 0 ? 'the repository\'s tests ran and exited 0' : `the repository's tests ran and exited ${a.evidence.exitCode}`) : `no test script in the repository — ${a.evidence.command.startsWith('for f') ? 'the changed files were syntax-checked' : 'nothing was run beyond a status'} (exit ${a.evidence.exitCode})`;
        const branch = `build/${a.runId}`;
        return {
          built: true, workspace, workspaceName: wsName, artifact, source: archive ? 'archive' : 'clone', ...(archive ? { baseCommit: archive.commit } : {}),
          record: `build.run:${a.runId}`,
          answer: `Built in a sandbox from ${a.repository}@${a.base}: ${a.files.length} file(s) — ${a.files.map((x) => x.path).join(', ')}. The model says: ${a.summary} Evidence: ${tests}. Nothing was pushed or deployed.`,
          note: 'the files and the recorded test evidence are the artifact in the workspace\'s vault; a pull request is a separate act under the forge connector\'s signature; a deployment is a promotion, later and its own',
          // What may follow (spec 368 §3): the SUBMISSION — a branch and a PR from these files, under the workspace's forge connector.
          next: { capability: GITHUB_PR_OPEN, args: { repo: a.repository, branch, title: a.summary.slice(0, 72) || a.task.slice(0, 72), body: `${a.task}\n\nBuilt by ${wsName ?? workspace}'s agent in a sandbox (build run ${a.runId}, record build.run:${a.runId}, files ${digest}${archive ? `, base ${archive.commit.slice(0, 12)}` : ''}).\nEvidence: \`${a.evidence.command}\` exited ${a.evidence.exitCode}.\n\n\`\`\`\n${a.evidence.outputTail.slice(-600)}\n\`\`\``, files: a.files, ...(a.workItem ? { workItem: a.workItem } : {}), holder: wsName ?? workspace }, words: `open a pull request with these ${a.files.length} file(s)`, why: 'a branch pushed is a submission — the forge connector acts under its holder\'s signature, and the PR names this build' },
        };
      }
      case BUILD_REVIEW:
      case BUILD_PROMOTE: {
        const runId = String(args.runId ?? '').trim();
        if (!/^build-[a-z0-9-]+$/.test(runId)) throw new Error('name the build run (runId: build-…)');
        if (!deps.readSubjectRecord) return { refused: 'this agent cannot read the workspace\'s records from here', workspace };
        const rec = (await deps.readSubjectRecord(workspace, `build.run:${runId}`).catch(() => null)) as BuildArtifactRecordV1 | null;
        if (!rec || rec.type !== 'ap.build-artifact.v1') return { refused: `no build run ${runId} in this workspace's records`, workspace, runId };
        const wsName = deps.nameOf ? await deps.nameOf(workspace).catch(() => null) : null;
        const token = githubTokenFor(deps.env, wsName);
        const repo = parseRepo(rec.repository);
        // The pull request opened FROM this run: the one whose body names the record (github.pr.open wrote it there).
        let pr: Awaited<ReturnType<typeof readPullRequest>> | null = null; let prNumber: number | null = null;
        if (token && repo) {
          const io = { api: githubApi(token, deps.fetch), repo };
          const list = await io.api.call<Array<{ number: number; body?: string }>>('GET', `/repos/${repo.owner}/${repo.name}/pulls?state=all&per_page=50&sort=created&direction=desc`);
          const hit = (Array.isArray(list.data) ? list.data : []).find((p) => (p.body ?? '').includes(`build.run:${runId}`));
          if (hit) { prNumber = hit.number; pr = await readPullRequest(io, hit.number).catch(() => null); }
        }
        const evidence = { command: rec.evidence.command, exitCode: rec.evidence.exitCode, ran: rec.evidence.ran, outputTail: rec.evidence.outputTail, recorded: true };
        const checks = !pr ? 'none' : pr.checks.length === 0 ? 'none' : pr.checks.some((c) => c.status !== 'completed') ? 'pending' : pr.checks.every((c) => !c.conclusion || ['success', 'neutral', 'skipped'].includes(c.conclusion)) ? 'pass' : 'fail';
        const review = {
          runId, workspace, repository: rec.repository, base: rec.base, task: rec.task, builtAt: rec.builtAt, model: rec.model,
          files: rec.files.map((x) => ({ path: x.path, chars: x.content.length })), digest: rec.digest,
          evidence, assertion: { by: rec.model, summary: rec.summary, note: 'the model\'s own claim about what it did — an assertion, apart from the evidence' },
          pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state, merged: pr.merged, branch: pr.branch, headSha: pr.headSha, checks: pr.checks, checksVerdict: checks, reviews: pr.reviews, binding: pr.binding } : null,
          ready: !!pr && !pr.merged && pr.state === 'open' && (checks === 'pass' || checks === 'none') && rec.evidence.exitCode === 0,
        };
        if (toolId === BUILD_REVIEW) {
          return { ...review, answer: `Build ${runId} in ${rec.repository}: ${rec.files.length} file(s) (${rec.files.map((x) => x.path).join(', ')}). Recorded evidence: \`${evidence.command.split(';').pop()?.trim()}\` exited ${evidence.exitCode}. The model asserts: ${rec.summary} ${pr ? `Pull request #${pr.number} is ${pr.merged ? 'merged' : pr.state}; the forge's checks: ${checks}; ${pr.reviews.length} review(s).` : 'No pull request has been opened from it yet.'}${review.ready ? ` Ready to promote: name run ${runId} and commit ${String(pr?.headSha ?? '').slice(0, 12)}.` : ''}` };
        }
        // PROMOTE — the steward's signature over the exact tuple (T29). The ask must name the run and the commit; the forge
        // must show that commit at the PR's head; checks must not fail or run; the merge is the environment (the default branch).
        if (!token || !repo) return { refused: `${wsName ?? workspace} holds no GitHub connector — a promotion reaches the forge through it`, workspace, runId };
        if (!pr || prNumber === null) return { refused: `no pull request was opened from build ${runId} — open one first (github.pr.open)`, workspace, runId };
        const commit = String(args.commit ?? '').trim().toLowerCase();
        const head = String(pr.headSha ?? '').toLowerCase();
        if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('name the commit the promotion is bound to (commit: the PR head sha from build.review)');
        if (!head || !head.startsWith(commit)) return { refused: `promotion refused: the tuple names commit ${commit.slice(0, 12)}, but pull request #${pr.number} is at ${head.slice(0, 12) || 'an unknown commit'} — the signature is over the exact commit`, workspace, runId };
        const goal = String((ctx.intent as { goal?: string }).goal ?? '').toLowerCase();
        if (!goal.includes(runId) || !goal.includes(commit.slice(0, 7))) throw new Error(`the promotion's ask must name the build run (${runId}) and the commit (${commit.slice(0, 7)}…) — the mandate is bound to that ask`);
        if (!pr.binding) return { refused: `pull request #${pr.number} carries no opening intent — it was not opened by a run; a promotion binds to the work as opened`, workspace, runId };
        const io = { api: githubApi(token, deps.fetch), repo };
        const merged = await mergePullRequest(io, pr.number, pr.binding.intentDigest, { requireChecks: true });
        const promotion: BuildPromotionRecordV1 = { type: 'ap.build-promotion.v1', runId, workspace, repository: rec.repository, commit: head, configDigest: rec.digest, environment: `branch:${rec.base}`, migration: 'none', pullRequest: pr.number, mergeSha: merged.sha ?? null, promotedUnder: intentDigest(ctx.intent), runRef: String((ctx as { runRef?: string }).runRef ?? ''), promotedAt: new Date().toISOString() };
        const wrote = deps.writeSubjectRecord ? await deps.writeSubjectRecord(workspace, `build.promotion:${runId}`, promotion).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })) : { ok: false, error: 'no record writer' };
        return { promoted: true, workspace, runId, repository: rec.repository, pullRequest: pr.number, mergeSha: merged.sha ?? null, tuple: { commit: head, configDigest: rec.digest, environment: promotion.environment, migration: 'none' }, promotedUnder: promotion.promotedUnder, record: wrote.ok ? `build.promotion:${runId}` : null, ...(wrote.ok ? {} : { recordError: wrote.error }), answer: `Promoted build ${runId}: pull request #${pr.number} merged into ${rec.base} (${merged.sha?.slice(0, 12) ?? 'merge'}) under a mandate bound to commit ${head.slice(0, 12)}, config ${rec.digest.slice(0, 19)}…, environment branch:${rec.base}, no migration.${wrote.ok ? '' : ' The promotion record could not be written.'}` };
      }
      case BUILD_RUN_LIST: {
        if (!deps.survey || !deps.readRecords) return { refused: 'this agent cannot read the workspace\'s records from here', workspace };
        const rows = (await deps.survey(workspace)).filter((r) => r.recordType.startsWith('build.run:'));
        const max = typeof args.max === 'number' && args.max > 0 ? Math.min(args.max, 50) : 20;
        const keys = rows.sort((x, y) => String(y.updatedAt ?? '').localeCompare(String(x.updatedAt ?? ''))).map((r) => r.recordType).slice(0, max);
        const records = keys.length ? await deps.readRecords(workspace, keys) : {};
        const filter = typeof args.repository === 'string' && args.repository ? args.repository.toLowerCase() : null;
        const runs = keys.map((k) => records[k] as BuildArtifactRecordV1 | undefined).filter((r): r is BuildArtifactRecordV1 => !!r && r.type === 'ap.build-artifact.v1' && (!filter || r.repository.toLowerCase() === filter)).map((r) => ({ runId: r.runId, record: `build.run:${r.runId}`, repository: r.repository, base: r.base, task: r.task, summary: r.summary, files: r.files.map((x) => x.path), evidence: { command: r.evidence.command, exitCode: r.evidence.exitCode }, model: r.model, builtAt: r.builtAt, runRef: r.runRef, ...(r.workItem ? { workItem: r.workItem } : {}) }));
        return { workspace, count: runs.length, runs, answer: runs.length ? runs.map((r) => `${r.builtAt.slice(0, 16).replace('T', ' ')} — ${r.repository}: ${r.task.slice(0, 80)} (${r.files.length} file(s), \`${r.evidence.command.split(';').pop()?.trim()}\` exit ${r.evidence.exitCode})`).join('\n') : 'No build runs yet for this workspace.' };
      }
      default: throw new Error(`${toolId} is not a build capability`);
    }
  };
}
