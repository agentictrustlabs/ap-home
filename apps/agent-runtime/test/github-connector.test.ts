// Spec 400 W3/W4 — the GitHub connector with a fake forge: the PR body carries the intent binding; a promotion merges
// only under a mandate bound to THAT intent (another intent's mandate is refused); an unbound PR cannot be promoted;
// the credential is the Worker's per-subject secret, absent ⇒ no connector (never a guess); the token never leaves.
import { describe, it, expect } from 'vitest';
import { githubTokenFor, prBindingLine, prBindingOf, openPullRequest, mergePullRequest, readPullRequest, readRepo, listRepositories, type GithubApi } from '../src/connectors/github.js';

function fakeForge() {
  const prs = new Map<number, { number: number; title: string; body: string; state: string; merged: boolean; head: { ref: string; sha: string } }>();
  const calls: string[] = [];
  let n = 0;
  const api: GithubApi = {
    async call(method, path, body) {
      calls.push(`${method} ${path}`);
      const b = body as Record<string, unknown>;
      if (method === 'GET' && path === '/repos/o/r') return { ok: true, status: 200, data: { default_branch: 'main', full_name: 'o/r' } };
      if (method === 'GET' && path === '/repos/o/r/branches?per_page=100') return { ok: true, status: 200, data: [{ name: 'feature/x' }, { name: 'main' }, { name: 'ap/work-1' }] };
      if (method === 'GET' && path.startsWith('/repos/o/r/pulls?state=open')) return { ok: true, status: 200, data: [] };
      if (method === 'GET' && path.startsWith('/user/repos?')) return { ok: true, status: 200, data: path.includes('page=1') ? [{ full_name: 'o/r', default_branch: 'main', private: false, html_url: 'https://gh/o/r', pushed_at: '2026-09-15T00:00:00Z', description: null, permissions: { push: true } }, { full_name: 'o/readonly', default_branch: 'main', private: true, html_url: 'https://gh/o/readonly', pushed_at: null, description: 'x', permissions: { push: false } }, { full_name: 'acme/site', default_branch: 'trunk', private: true, html_url: 'https://gh/acme/site', pushed_at: null, description: null, permissions: { push: true } }] : [] };
      if (method === 'GET' && path === '/repos/o/r/git/ref/heads/main') return { ok: true, status: 200, data: { object: { sha: 'base' } } };
      if (method === 'POST' && path === '/repos/o/r/git/refs') return { ok: true, status: 201, data: {} };
      if (method === 'GET' && path.startsWith('/repos/o/r/contents/')) return { ok: false, status: 404, data: {} };
      if (method === 'PUT' && path.startsWith('/repos/o/r/contents/')) return { ok: true, status: 201, data: { commit: { sha: 'c1' } } };
      if (method === 'POST' && path === '/repos/o/r/pulls') { n += 1; prs.set(n, { number: n, title: String(b.title), body: String(b.body), state: 'open', merged: false, head: { ref: String(b.head), sha: 'c1' } }); return { ok: true, status: 201, data: { number: n, html_url: `https://gh/o/r/pull/${n}` } }; }
      const m = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
      if (method === 'GET' && m) { const p = prs.get(Number(m[1])); return p ? { ok: true, status: 200, data: { ...p, mergeable: true, html_url: `https://gh/o/r/pull/${p.number}`, comments: 0 } } : { ok: false, status: 404, data: { message: 'nope' } }; }
      if (method === 'GET' && path.includes('/check-runs')) return { ok: true, status: 200, data: { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } };
      if (method === 'GET' && path.endsWith('/reviews')) return { ok: true, status: 200, data: [{ user: { login: 'alice' }, state: 'APPROVED' }] };
      const mm = /^\/repos\/o\/r\/pulls\/(\d+)\/merge$/.exec(path);
      if (method === 'PUT' && mm) { const p = prs.get(Number(mm[1]))!; p.merged = true; p.state = 'closed'; return { ok: true, status: 200, data: { merged: true, sha: 'm1' } }; }
      return { ok: false, status: 500, data: { message: `unexpected ${method} ${path}` } };
    },
  };
  return { api, prs, calls };
}
const D1 = `0x${'a'.repeat(64)}`; const D2 = `0x${'b'.repeat(64)}`;

describe('GitHub connector (W3/W4)', () => {
  it('lists the repositories the credential can WRITE to (the picker\'s list), narrowed by words; the read carries the branches, default first', async () => {
    const f = fakeForge();
    const all = await listRepositories(f.api);
    expect(all.repositories.map((r) => r.repo)).toEqual(['o/r', 'acme/site']); expect(all.total).toBe(2); expect(all.truncated).toBe(false);
    expect((await listRepositories(f.api, { q: 'site' })).repositories.map((r) => r.repo)).toEqual(['acme/site']);
    const read = await readRepo({ api: f.api, repo: { owner: 'o', name: 'r' } });
    expect(read.branches).toEqual(['main', 'ap/work-1', 'feature/x']); expect(read.defaultBranch).toBe('main');
  });
  it('the credential is the subject\'s Worker secret, or nothing', () => {
    expect(githubTokenFor({ AP_CONNECTOR_GITHUB_TOKEN_MISSIO_NEXUS_ORG: 'ghp_x' }, 'missio-nexus.org')).toBe('ghp_x');
    expect(githubTokenFor({ AP_CONNECTOR_GITHUB_TOKEN_MISSIO_NEXUS_ORG: 'ghp_x' }, 'alice.me')).toBeNull();
    expect(githubTokenFor({}, null)).toBeNull();
  });
  it('the PR body binding round-trips', () => {
    expect(prBindingOf(`hello${prBindingLine(D1, 'run-7', 'endeavor-3')}`)).toEqual({ intentDigest: D1, runRef: 'run-7' });
    expect(prBindingOf('no binding here')).toBeNull();
  });
  it('opens a PR bound to the intent, and promotes only under a mandate bound to that intent', async () => {
    const f = fakeForge();
    const io = { api: f.api, repo: { owner: 'o', name: 'r' } };
    const pr = await openPullRequest(io, { branch: 'ap/work-1', title: 'the work', body: 'what was done', files: [{ path: 'NOTES.md', content: 'hi' }], intentDigest: D1, runRef: 'run-7' });
    expect(pr).toMatchObject({ number: 1, branch: 'ap/work-1', commit: 'c1' });
    expect((await readPullRequest(io, 1)).binding).toEqual({ intentDigest: D1, runRef: 'run-7' });
    await expect(mergePullRequest(io, 1, D2)).rejects.toThrow(/promotion refused: the mandate is bound to intent/);
    expect(f.prs.get(1)!.merged).toBe(false);
    const merged = await mergePullRequest(io, 1, D1, { requireChecks: true });
    expect(merged).toMatchObject({ merged: true, sha: 'm1', binding: { intentDigest: D1 } });
    // no token ever appeared in a path or body the fake saw
    expect(f.calls.join(' ')).not.toMatch(/ghp_/);
  });
  it('an unbound PR cannot be promoted', async () => {
    const f = fakeForge();
    const io = { api: f.api, repo: { owner: 'o', name: 'r' } };
    await f.api.call('POST', '/repos/o/r/pulls', { title: 'manual', head: 'x', body: 'opened by hand' });
    await expect(mergePullRequest(io, 1, D1)).rejects.toThrow(/carries no ap:intent binding/);
  });
});
