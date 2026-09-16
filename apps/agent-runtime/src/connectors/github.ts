// SPEC 400 W4 + W3 — GITHUB AS A CONNECTOR, under the delegation model. A connector is an outside service reached
// with a credential the WORKER holds (`AP_CONNECTOR_GITHUB_TOKEN_<SUBJECT NAME>`, a Worker secret per subject — an
// organization or a person); the agent never carries the bearer: it asks, under a MANDATE, for one named act
// (`github.pr.open`, `github.pr.merge` …), the harness verifies the mandate as it does any act, this module performs
// it with the subject's credential, and the run's receipt is the record. "Mandate in, receipt out."
//
// THE REVIEW LOOP (W3, the visible product hole): a work item → a branch → a PR whose body names the INTENT DIGEST
// and the RUN it came from → review (comments; the forge's checks as test evidence) → PROMOTION: a merge that is
// refused unless the mandate presented for it is bound to the very intent the PR names. GitHub is the forge; we
// keep no forge of our own.
import type { Address } from 'viem';

export interface GithubEnv { [k: string]: unknown }

/** `missio-nexus.org` → `MISSIO_NEXUS_ORG`. */
export const connectorSecretSuffix = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The subject's GitHub credential, from the Worker's secrets; absent ⇒ the subject has no GitHub connector (said, never guessed). */
export function githubTokenFor(env: GithubEnv, subjectName: string | null): string | null {
  if (!subjectName) return null;
  const v = env[`AP_CONNECTOR_GITHUB_TOKEN_${connectorSecretSuffix(subjectName)}`];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface GithubApi {
  /** One REST call with the subject's credential; the caller never sees the token. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }>;
}

export function githubApi(token: string, fetchImpl: typeof fetch = fetch): GithubApi {
  return {
    async call<T>(method: string, path: string, body?: unknown) {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agenticprimitives-connector', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data: data as T };
    },
  };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const parseRepo = (repo: string): { owner: string; name: string } | null => (REPO_RE.test(repo) ? { owner: repo.split('/')[0]!, name: repo.split('/')[1]! } : null);

/** What a PR body carries so the promotion can be BOUND: the intent digest of the run that opened it, and the run. */
export const PR_BINDING_RE = /ap:intent=(0x[0-9a-f]{64})\s+ap:run=(\S+)/i;
export const prBindingLine = (intentDigest: string, runRef: string, workItem?: string): string => `\n\n---\nap:intent=${intentDigest.toLowerCase()} ap:run=${runRef}${workItem ? `\nap:work=${workItem}` : ''}\n`;
export function prBindingOf(body: string | null | undefined): { intentDigest: string; runRef: string } | null {
  const m = PR_BINDING_RE.exec(body ?? '');
  return m ? { intentDigest: m[1]!.toLowerCase(), runRef: m[2]! } : null;
}

const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export interface ForgeIo { api: GithubApi; repo: { owner: string; name: string } }

/** Read a repository: its default branch, the newest open PRs, one file when asked. */
/** The repositories the subject's credential can WRITE to — what a PR could be opened on; a Home's picker lists exactly
 *  these, because a repository outside them is one the submission would be refused on. Read-only, bounded, never the
 *  token. `q` narrows by words in the name. */
export async function listRepositories(api: GithubApi, opts: { q?: string; max?: number } = {}): Promise<{ repositories: Array<{ repo: string; defaultBranch: string; private: boolean; url: string; pushedAt: string | null; description: string | null }>; total: number; truncated: boolean }> {
  const max = Math.min(Math.max(opts.max ?? 60, 1), 200);
  const rows: Array<{ full_name: string; default_branch: string; private: boolean; html_url: string; pushed_at: string | null; description: string | null; permissions?: { push?: boolean } }> = [];
  for (let page = 1; page <= 4 && rows.length < 400; page++) {
    const r = await api.call<typeof rows | { message?: string }>('GET', `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`);
    if (!r.ok) throw new Error(`GitHub: ${(r.data as { message?: string })?.message ?? `repositories read failed (${r.status})`}`);
    const arr = Array.isArray(r.data) ? r.data : [];
    rows.push(...arr);
    if (arr.length < 100) break;
  }
  const q = (opts.q ?? '').trim().toLowerCase();
  const writable = rows.filter((x) => x.permissions?.push !== false).filter((x) => !q || x.full_name.toLowerCase().includes(q));
  return {
    repositories: writable.slice(0, max).map((x) => ({ repo: x.full_name, defaultBranch: x.default_branch, private: x.private, url: x.html_url, pushedAt: x.pushed_at, description: x.description })),
    total: writable.length, truncated: writable.length > max,
  };
}

export async function readRepo(io: ForgeIo, path?: string): Promise<Record<string, unknown>> {
  const r = await io.api.call<{ default_branch?: string; full_name?: string; private?: boolean; html_url?: string; message?: string }>('GET', `/repos/${io.repo.owner}/${io.repo.name}`);
  if (!r.ok) throw new Error(`GitHub: ${r.data?.message ?? `repository read failed (${r.status})`}`);
  const prs = await io.api.call<Array<{ number: number; title: string; state: string; html_url: string; head: { ref: string }; body?: string }>>('GET', `/repos/${io.repo.owner}/${io.repo.name}/pulls?state=open&per_page=10`);
  // The branches a build can start from (bounded to the first 100, the default branch first).
  const br = await io.api.call<Array<{ name: string; commit?: { sha?: string } }>>('GET', `/repos/${io.repo.owner}/${io.repo.name}/branches?per_page=100`);
  const branches = (Array.isArray(br.data) ? br.data : []).map((b) => b.name).sort((a, b) => (a === r.data.default_branch ? -1 : b === r.data.default_branch ? 1 : a.localeCompare(b)));
  const out: Record<string, unknown> = {
    repo: r.data.full_name, defaultBranch: r.data.default_branch, url: r.data.html_url, private: r.data.private, branches,
    openPullRequests: (Array.isArray(prs.data) ? prs.data : []).map((p) => ({ number: p.number, title: p.title, branch: p.head.ref, url: p.html_url, ...(prBindingOf(p.body) ? { binding: prBindingOf(p.body) } : {}) })),
  };
  if (path) {
    const f = await io.api.call<{ content?: string; encoding?: string; sha?: string; message?: string }>('GET', `/repos/${io.repo.owner}/${io.repo.name}/contents/${path.replace(/^\//, '')}`);
    out.file = f.ok && f.data.content ? { path, sha: f.data.sha, text: new TextDecoder().decode(Uint8Array.from(atob(f.data.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))).slice(0, 4000) } : { path, error: f.data?.message ?? `not found (${f.status})` };
  }
  return out;
}

/** A branch off the default branch (or `from`), a file written on it, and a PR whose body names the intent + run. */
export async function openPullRequest(io: ForgeIo, input: { branch: string; title: string; body: string; from?: string; files?: Array<{ path: string; content: string }>; commitMessage?: string; intentDigest: string; runRef: string; workItem?: string }): Promise<{ number: number; url: string; branch: string; commit?: string }> {
  const repo = `/repos/${io.repo.owner}/${io.repo.name}`;
  const base = input.from ?? ((await io.api.call<{ default_branch?: string }>('GET', repo)).data.default_branch ?? 'main');
  const ref = await io.api.call<{ object?: { sha: string }; message?: string }>('GET', `${repo}/git/ref/heads/${base}`);
  if (!ref.ok || !ref.data.object) throw new Error(`GitHub: base branch ${base} not found (${ref.data?.message ?? ref.status})`);
  const made = await io.api.call<{ message?: string }>('POST', `${repo}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: ref.data.object.sha });
  if (!made.ok && made.status !== 422) throw new Error(`GitHub: branch not created (${made.data?.message ?? made.status})`);
  let commit: string | undefined;
  for (const f of input.files ?? []) {
    const existing = await io.api.call<{ sha?: string }>('GET', `${repo}/contents/${f.path}?ref=${encodeURIComponent(input.branch)}`);
    const put = await io.api.call<{ commit?: { sha: string }; message?: string }>('PUT', `${repo}/contents/${f.path}`, { message: input.commitMessage ?? input.title, content: b64(f.content), branch: input.branch, ...(existing.ok && existing.data.sha ? { sha: existing.data.sha } : {}) });
    if (!put.ok) throw new Error(`GitHub: ${f.path} not written (${put.data?.message ?? put.status})`);
    commit = put.data.commit?.sha;
  }
  const pr = await io.api.call<{ number?: number; html_url?: string; message?: string; errors?: unknown[] }>('POST', `${repo}/pulls`, { title: input.title, head: input.branch, base, body: `${input.body}${prBindingLine(input.intentDigest, input.runRef, input.workItem)}` });
  if (!pr.ok || !pr.data.number) {
    // An open PR for this branch already exists: that is the one (the act is one-per-request; a resume finds it).
    const open = await io.api.call<Array<{ number: number; html_url: string }>>('GET', `${repo}/pulls?state=open&head=${io.repo.owner}:${encodeURIComponent(input.branch)}`);
    const have = Array.isArray(open.data) ? open.data[0] : undefined;
    if (!have) throw new Error(`GitHub: pull request not opened (${pr.data?.message ?? pr.status}${pr.data?.errors ? ` ${JSON.stringify(pr.data.errors).slice(0, 160)}` : ''})`);
    return { number: have.number, url: have.html_url, branch: input.branch, ...(commit ? { commit } : {}) };
  }
  return { number: pr.data.number, url: pr.data.html_url!, branch: input.branch, ...(commit ? { commit } : {}) };
}

export async function commentOnPullRequest(io: ForgeIo, number: number, body: string): Promise<{ id: number; url: string }> {
  const r = await io.api.call<{ id?: number; html_url?: string; message?: string }>('POST', `/repos/${io.repo.owner}/${io.repo.name}/issues/${number}/comments`, { body });
  if (!r.ok || !r.data.id) throw new Error(`GitHub: comment not posted (${r.data?.message ?? r.status})`);
  return { id: r.data.id, url: r.data.html_url! };
}

/** The evidence a promotion reads: the PR's state, its binding, its checks (the forge's tests), its reviews. */
export async function readPullRequest(io: ForgeIo, number: number): Promise<{ number: number; title: string; state: string; merged: boolean; mergeable: boolean | null; url: string; branch: string; binding: { intentDigest: string; runRef: string } | null; checks: Array<{ name: string; status: string; conclusion: string | null }>; reviews: Array<{ user: string; state: string }>; comments: number }> {
  const repo = `/repos/${io.repo.owner}/${io.repo.name}`;
  const pr = await io.api.call<{ number: number; title: string; state: string; merged: boolean; mergeable: boolean | null; html_url: string; head: { ref: string; sha: string }; body?: string; comments?: number; message?: string }>('GET', `${repo}/pulls/${number}`);
  if (!pr.ok) throw new Error(`GitHub: pull request ${number} not read (${pr.data?.message ?? pr.status})`);
  const checks = await io.api.call<{ check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }>('GET', `${repo}/commits/${pr.data.head.sha}/check-runs`);
  const reviews = await io.api.call<Array<{ user?: { login?: string }; state: string }>>('GET', `${repo}/pulls/${number}/reviews`);
  return {
    number: pr.data.number, title: pr.data.title, state: pr.data.state, merged: pr.data.merged, mergeable: pr.data.mergeable, url: pr.data.html_url, branch: pr.data.head.ref,
    binding: prBindingOf(pr.data.body), checks: checks.data?.check_runs ?? [], reviews: (Array.isArray(reviews.data) ? reviews.data : []).map((r) => ({ user: r.user?.login ?? '?', state: r.state })), comments: pr.data.comments ?? 0,
  };
}

/** PROMOTION BOUND TO AN INTENT: merge only when the PR's binding names the intent digest the mandate is bound to. */
export async function mergePullRequest(io: ForgeIo, number: number, mandateIntentDigest: string, opts: { requireChecks?: boolean } = {}): Promise<{ merged: boolean; sha?: string; url: string; binding: { intentDigest: string; runRef: string } }> {
  const pr = await readPullRequest(io, number);
  if (!pr.binding) throw new Error(`pull request #${number} carries no ap:intent binding — it was not opened by a run, and a promotion is bound to the intent that opened the work`);
  if (pr.binding.intentDigest !== mandateIntentDigest.toLowerCase()) throw new Error(`promotion refused: the mandate is bound to intent ${mandateIntentDigest.slice(0, 14)}…, but pull request #${number} was opened under ${pr.binding.intentDigest.slice(0, 14)}… — a merge is authorized for the work it names, not for another`);
  if (pr.merged) return { merged: true, url: pr.url, binding: pr.binding };
  if (opts.requireChecks) {
    const failing = pr.checks.filter((c) => c.status === 'completed' && c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion));
    const pending = pr.checks.filter((c) => c.status !== 'completed');
    if (failing.length || pending.length) throw new Error(`promotion refused: checks ${failing.length ? `failing (${failing.map((c) => c.name).join(', ')})` : `still running (${pending.map((c) => c.name).join(', ')})`}`);
  }
  const r = await io.api.call<{ merged?: boolean; sha?: string; message?: string }>('PUT', `/repos/${io.repo.owner}/${io.repo.name}/pulls/${number}/merge`, { merge_method: 'squash', commit_title: `${pr.title} (#${number})`, commit_message: `promoted under intent ${pr.binding.intentDigest} · run ${pr.binding.runRef}` });
  if (!r.ok || !r.data.merged) throw new Error(`GitHub: merge refused (${r.data?.message ?? r.status})`);
  return { merged: true, ...(r.data.sha ? { sha: r.data.sha } : {}), url: pr.url, binding: pr.binding };
}
