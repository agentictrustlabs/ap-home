// SPEC 400 W3/W4 — GitHub AS CAPABILITIES. Reads are lookups; acts need the SUBJECT's mandate (`authorityArg: holder`
// — the organization or person whose connector it is; a steward signs for an organization). The token is the
// Worker's per-subject secret; the harness's receipt is the record of each act. The review loop's four verbs:
// open (a branch, a change, a PR bound to this run's intent), comment (review), read (evidence: checks, reviews),
// merge (PROMOTION — refused unless the mandate's intent names the PR and the intent the work was opened under).
import { ADAPTER } from '../adapter-declarations.js';
import type { ToolSpec, ToolInvoker } from '@agenticprimitives/orchestration';
import { intentDigest } from '@agenticprimitives/delegation';
import { githubApi, githubTokenFor, parseRepo, readRepo, listRepositories, openPullRequest, commentOnPullRequest, readPullRequest, mergePullRequest, type GithubEnv } from './github.js';

export const GITHUB_REPO_READ = 'github.repo.read' as const;
export const GITHUB_REPOS_LIST = 'github.repos.list' as const;
export const GITHUB_PR_OPEN = 'github.pr.open' as const;
export const GITHUB_PR_COMMENT = 'github.pr.comment' as const;
export const GITHUB_PR_READ = 'github.pr.read' as const;
export const GITHUB_PR_MERGE = 'github.pr.merge' as const;
export const GITHUB_ACTS = new Set<string>([GITHUB_PR_OPEN, GITHUB_PR_COMMENT, GITHUB_PR_MERGE]);

const holderArg = { holder: { type: 'string', description: 'Whose GitHub connector — the organization (or person) the repository belongs to, a name or address' } };

export const GITHUB_TOOLS: ToolSpec[] = [
  {
    id: GITHUB_REPOS_LIST,
    answers: ['which repositories', 'list the repositories', 'what repos do we have', 'the repositories we can build in', 'our github repos'],
    description: 'LISTS the GitHub repositories the subject\'s connector can WRITE to — the ones a build or a pull request could land on — each with its default branch; `q` narrows by name, `max` caps the count. Never reads their contents. Args: q (optional), max (optional), holder (whose connector).',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Words in the repository name (optional)' }, max: { type: 'integer' }, ...holderArg } },
    establishes: 'lookup',
  },
  {
    id: GITHUB_REPO_READ,
    answers: ['what is in the repository', 'open pull requests', 'read the repo', 'show the file', 'what branches'],
    description: 'READS a GitHub repository the subject holds a connector for: its default branch, its branches, the open pull requests (each with the intent binding it was opened under, if any), and one file when `path` is given. Args: repo (owner/name), path (optional), holder (whose connector).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, path: { type: 'string', description: 'A file path to read (optional)' }, ...holderArg }, required: ['repo'] },
    establishes: 'lookup',
  },
  {
    id: GITHUB_PR_OPEN,
    adapter: ADAPTER.external,
    verbs: ['open a pull request', 'open a pr', 'propose the change', 'push the change', 'start the work on'],
    description: 'OPENS A PULL REQUEST on GitHub for a piece of work: a branch off the default branch, the files given written on it, and a PR whose body names the INTENT this run acts under and the run — what a later promotion is bound to. Args: repo (owner/name), branch, title, body, files (optional: [{path, content}]), workItem (optional: the endeavor step), holder (whose connector — the organization).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, branch: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, workItem: { type: 'string' }, ...holderArg }, required: ['repo', 'branch', 'title'] },
    capability: { id: GITHUB_PR_OPEN, action: 'open', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'medium',
    establishes: 'submission',
  },
  {
    id: GITHUB_PR_COMMENT,
    adapter: ADAPTER.external,
    verbs: ['comment on the pull request', 'review the pr', 'leave a review comment', 'say on the pr'],
    description: 'COMMENTS on a pull request — a review in the thread where the work is. Args: repo (owner/name), number, body, holder (whose connector).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, body: { type: 'string' }, ...holderArg }, required: ['repo', 'number', 'body'] },
    capability: { id: GITHUB_PR_COMMENT, action: 'comment', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'low',
  },
  {
    id: GITHUB_PR_READ,
    answers: ['is the pull request ready', 'what do the checks say', 'the reviews on the pr', 'is it merged', 'status of the pull request'],
    description: 'READS one pull request as EVIDENCE: state, the intent it was opened under, the checks (the forge\'s tests), the reviews, whether it merged. Args: repo (owner/name), number, holder (whose connector).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, ...holderArg }, required: ['repo', 'number'] },
    establishes: 'lookup',
  },
  {
    id: GITHUB_PR_MERGE,
    adapter: ADAPTER.external,
    verbs: ['promote', 'merge the pull request', 'merge the pr', 'ship it', 'land the change'],
    description: 'PROMOTES a pull request — merges it — under a mandate BOUND to the work: the ask must name the pull request number AND the intent the work was opened under (the digest in the PR\'s body, as github.pr.read shows it); a mandate for anything else is refused. Refused too while the forge\'s checks fail or run. Args: repo (owner/name), number, opened (the opening intent digest, 0x…), holder (whose connector).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, opened: { type: 'string', description: 'The intent digest the PR was opened under (from github.pr.read)' }, ...holderArg }, required: ['repo', 'number', 'opened'] },
    capability: { id: GITHUB_PR_MERGE, action: 'merge', resourceArg: 'holder', authorityArg: 'holder' },
    risk: 'high',
  },
];

export interface GithubToolDeps {
  env: GithubEnv;
  nameOf?: (address: string) => Promise<string | null>;
  resolveName?: (name: string) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** The subject whose connector: the mandate's delegator for an act, `holder` for a read; resolved to a NAME, because the
 *  secret is keyed by the subject's typed name. */
async function subjectOf(deps: GithubToolDeps, args: Record<string, unknown>, presented: { wire?: { delegator?: string } } | null, person: string | undefined): Promise<{ address: string; name: string | null }> {
  const fromMandate = presented?.wire?.delegator;
  const raw = String(args.holder ?? fromMandate ?? person ?? '').trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : '';
  if (!address && raw && deps.resolveName) address = ((await deps.resolveName(raw).catch(() => null)) ?? '').toLowerCase();
  if (!address) throw new Error('whose GitHub connector? — name the organization (holder)');
  if (fromMandate && fromMandate.toLowerCase() !== address) throw new Error(`the mandate is ${fromMandate}'s, but the connector asked for is ${address}'s — an act on a connector is authorized by its holder`);
  const name = /^0x/.test(raw) || !raw ? (deps.nameOf ? await deps.nameOf(address).catch(() => null) : null) : raw.toLowerCase();
  return { address, name };
}

export function githubInvoker(deps: GithubToolDeps, presented: { wire?: { delegator?: string } } | null, person: string | undefined): ToolInvoker {
  return async (toolId, args, ctx) => {
    const subject = await subjectOf(deps, args, presented, person);
    const token = githubTokenFor(deps.env, subject.name);
    if (!token) return { refused: `${subject.name ?? subject.address} holds no GitHub connector on this deployment — a steward connects one (the credential is kept by the platform, never by an agent)` };
    const holder = subject.address;
    if (toolId === GITHUB_REPOS_LIST) {
      const out = await listRepositories(githubApi(token, deps.fetch), { ...(typeof args.q === 'string' ? { q: args.q } : {}), ...(typeof args.max === 'number' ? { max: args.max } : {}) });
      return { holder, connected: true, ...out, answer: out.repositories.length ? `${out.total} repositor${out.total === 1 ? 'y' : 'ies'} the connector can write to${out.truncated ? ` (first ${out.repositories.length})` : ''}:\n${out.repositories.map((r) => `${r.repo} (${r.defaultBranch}${r.private ? ', private' : ''})`).join('\n')}` : 'The connector can write to no repository.' };
    }
    const repo = parseRepo(String(args.repo ?? ''));
    if (!repo) throw new Error(`repo must be owner/name (got ${String(args.repo ?? '')})`);
    const io = { api: githubApi(token, deps.fetch), repo };
    switch (toolId) {
      case GITHUB_REPO_READ: return { holder, ...(await readRepo(io, typeof args.path === 'string' ? args.path : undefined)) };
      case GITHUB_PR_READ: return { holder, ...(await readPullRequest(io, Number(args.number))) };
      case GITHUB_PR_OPEN: {
        const digest = intentDigest(ctx.intent);
        // The run: the idempotency key a medium-risk step carries is `<runRef>:<stepRef>` (orchestration/loop.ts).
        const runRef = String((ctx as { runRef?: string }).runRef ?? (ctx.idempotencyKey ? ctx.idempotencyKey.split(':').slice(0, -1).join(':') : '') ?? '') || 'run';
        const files = Array.isArray(args.files) ? (args.files as Array<{ path?: unknown; content?: unknown }>).filter((f) => typeof f.path === 'string' && typeof f.content === 'string').map((f) => ({ path: String(f.path), content: String(f.content) })) : [];
        const out = await openPullRequest(io, { branch: String(args.branch), title: String(args.title), body: String(args.body ?? ''), files, intentDigest: digest, runRef, ...(typeof args.workItem === 'string' ? { workItem: args.workItem } : {}) });
        return { opened: true, holder, repo: `${repo.owner}/${repo.name}`, ...out, boundTo: { intentDigest: digest, runRef }, note: 'the pull request names the intent and the run it was opened under; a promotion is bound to that intent' };
      }
      case GITHUB_PR_COMMENT: return { commented: true, holder, repo: `${repo.owner}/${repo.name}`, number: Number(args.number), ...(await commentOnPullRequest(io, Number(args.number), String(args.body))) };
      case GITHUB_PR_MERGE: {
        const number = Number(args.number);
        const opened = String(args.opened ?? '').toLowerCase();
        // THE BINDING, twice: the ask (what the mandate's intent digest is over) must name the PR and the opening
        // digest; and the forge's PR must carry that same opening digest. A mandate signed for "promote #3 opened
        // under 0xabc…" is then a mandate for exactly this promotion and no other.
        const goal = String((ctx.intent as { goal?: string }).goal ?? '');
        if (!/^0x[0-9a-f]{64}$/.test(opened)) throw new Error('name the intent the pull request was opened under (opened: 0x…, from github.pr.read)');
        if (!goal.includes(`#${number}`) || !goal.toLowerCase().includes(opened.slice(0, 14))) throw new Error(`the promotion's ask must name the pull request (#${number}) and the intent it was opened under (${opened.slice(0, 14)}…) — the mandate is bound to that ask`);
        const out = await mergePullRequest(io, number, opened, { requireChecks: true });
        return { promoted: true, holder, repo: `${repo.owner}/${repo.name}`, number, ...out, promotedUnder: intentDigest(ctx.intent) };
      }
      default: throw new Error(`${toolId} is not a GitHub capability`);
    }
  };
}
