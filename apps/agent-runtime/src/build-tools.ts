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

export const BUILD_RUN = 'build.run' as const;
export const BUILD_RUN_LIST = 'build.run.list' as const;
export const BUILD_ACTS = new Set<string>([BUILD_RUN]);

export interface BuildEnv { BUILD_SERVICE_URL?: string; BUILD_SERVICE_TOKEN?: string }

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
  fetch?: typeof fetch;
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
  return async (toolId, args) => {
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
        const res = await f(`${url.replace(/\/$/, '')}/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ repository, task, ...(typeof args.base === 'string' && args.base ? { base: args.base } : {}), ...(typeof args.workItem === 'string' && args.workItem ? { workItem: args.workItem } : {}), workspace }) });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; artifact?: ServiceArtifact; error?: string };
        if (!res.ok || !body.ok || !body.artifact) return { refused: `the build did not complete: ${body.error ?? `the Build service answered ${res.status}`}`, workspace, repository, task };
        const a = body.artifact;
        const digest = 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(a.files))))].map((b) => b.toString(16).padStart(2, '0')).join('');
        const model = `${a.model.provider}/${a.model.model}`;
        const artifact: Omit<BuildArtifactRecordV1, 'type' | 'workspace' | 'runRef' | 'mandateRef' | 'builtAt'> & { at: string; sandbox: ServiceArtifact['sandbox'] } = { runId: a.runId, repository: a.repository, base: a.base, task: a.task, summary: a.summary, files: a.files, evidence: a.evidence, model, digest, at: a.at, sandbox: a.sandbox, ...(a.workItem ? { workItem: a.workItem } : {}) };
        const tests = a.evidence.command.includes('npm test') ? (a.evidence.exitCode === 0 ? 'the repository\'s tests ran and exited 0' : `the repository's tests ran and exited ${a.evidence.exitCode}`) : `no test script in the repository — ${a.evidence.command.startsWith('for f') ? 'the changed files were syntax-checked' : 'nothing was run beyond a status'} (exit ${a.evidence.exitCode})`;
        const wsName = deps.nameOf ? await deps.nameOf(workspace).catch(() => null) : null;
        const branch = `build/${a.runId}`;
        return {
          built: true, workspace, workspaceName: wsName, artifact,
          record: `build.run:${a.runId}`,
          answer: `Built in a sandbox from ${a.repository}@${a.base}: ${a.files.length} file(s) — ${a.files.map((x) => x.path).join(', ')}. The model says: ${a.summary} Evidence: ${tests}. Nothing was pushed or deployed.`,
          note: 'the files and the recorded test evidence are the artifact in the workspace\'s vault; a pull request is a separate act under the forge connector\'s signature; a deployment is a promotion, later and its own',
          // What may follow (spec 368 §3): the SUBMISSION — a branch and a PR from these files, under the workspace's forge connector.
          next: { capability: GITHUB_PR_OPEN, args: { repo: a.repository, branch, title: a.summary.slice(0, 72) || a.task.slice(0, 72), body: `${a.task}\n\nBuilt by ${wsName ?? workspace}'s agent in a sandbox (build run ${a.runId}, record build.run:${a.runId}, files ${digest}).\nEvidence: \`${a.evidence.command}\` exited ${a.evidence.exitCode}.\n\n\`\`\`\n${a.evidence.outputTail.slice(-600)}\n\`\`\``, files: a.files, ...(a.workItem ? { workItem: a.workItem } : {}), holder: wsName ?? workspace }, words: `open a pull request with these ${a.files.length} file(s)`, why: 'a branch pushed is a submission — the forge connector acts under its holder\'s signature, and the PR names this build' },
        };
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
