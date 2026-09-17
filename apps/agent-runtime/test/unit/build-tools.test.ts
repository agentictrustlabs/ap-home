import { describe, it, expect } from 'vitest';
import { buildInvoker, BUILD_RUN, BUILD_RUN_LIST, BUILD_TOOLS, BUILD_ACTS } from '../../src/build-tools.js';
import { declaredEffectSink } from '@agenticprimitives/harness';

const ORG = '0x3b99f2b452766de5df0dbcdfc676f27257151333';
const artifact = { type: 'ap.build.artifact.v1', runId: 'build-1', repository: 'acme/site', base: 'main', task: 'add CONTRIBUTING.md', files: [{ path: 'CONTRIBUTING.md', content: '# Contributing\n' }], summary: 'Added CONTRIBUTING.md.', evidence: { command: 'git status --short', exitCode: 0, ran: true, outputTail: '?? CONTRIBUTING.md', durationMs: 50 }, model: { provider: 'xai', model: 'grok-4.20-0309-non-reasoning' }, sandbox: { image: 'i', sdk: '0.12.9', cloneMs: 1000, totalMs: 2000 }, at: '2026-09-15T00:00:00.000Z' };
const service = (calls: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }>, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization, body: JSON.parse(String(init?.body)) });
  return new Response(JSON.stringify(status === 200 ? { ok: true, artifact } : { ok: false, error: 'the model answered 429' }), { status });
}) as unknown as typeof fetch;
const env = { BUILD_SERVICE_URL: 'https://build.example/', BUILD_SERVICE_TOKEN: 't' };

describe('build.run — the workspace\'s act in the Build service\'s sandbox (spec 398 §9 / ap-build B3)', () => {
  it('is an act on the ladder: the mandate\'s resource and authority are the WORKSPACE agent, never a string', () => {
    const t = BUILD_TOOLS.find((x) => x.id === BUILD_RUN)!;
    expect(BUILD_ACTS.has(BUILD_RUN)).toBe(true); expect(t.capability).toEqual({ id: BUILD_RUN, action: 'build', resourceArg: 'workspace', authorityArg: 'workspace' }); expect(t.establishes).toBe('submission');
    expect(BUILD_ACTS.has(BUILD_RUN_LIST)).toBe(false);
  });
  it('calls the service under the bearer, returns the artifact with a digest, and PROPOSES the PR — never opens it', async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    const inv = buildInvoker({ env, fetch: service(calls), nameOf: async () => 'missio-nexus.org' }, { wire: { delegator: ORG } }, ORG);
    const r = await inv(BUILD_RUN, { repository: 'acme/site', task: 'add CONTRIBUTING.md', workspace: ORG }, {} as never) as { built: boolean; workspace: string; artifact: { digest: string; model: string; files: unknown[] }; record: string; next: { capability: string; args: Record<string, unknown> }; answer: string };
    expect(calls[0]!.url).toBe('https://build.example/runs'); expect(calls[0]!.auth).toBe('Bearer t'); expect(calls[0]!.body.repository).toBe('acme/site');
    expect(r.built).toBe(true); expect(r.workspace).toBe(ORG); expect(r.record).toBe('build.run:build-1'); expect(r.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/); expect(r.artifact.model).toBe('xai/grok-4.20-0309-non-reasoning');
    expect(r.next.capability).toBe('github.pr.open'); expect(r.next.args.repo).toBe('acme/site'); expect(r.next.args.branch).toBe('build/build-1'); expect(r.next.args.files).toEqual(artifact.files); expect(r.next.args.holder).toBe('missio-nexus.org');
    expect(String(r.next.args.body)).toContain('build.run:build-1');
    expect(r.answer).toMatch(/Nothing was pushed or deployed/); expect(r.answer).not.toMatch(/tests pass/i);
  });
  it('the mandate binds the workspace: another workspace\'s ask under this mandate is refused; a malformed repository never reaches the service', async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    const inv = buildInvoker({ env, fetch: service(calls) }, { wire: { delegator: ORG } }, ORG);
    await expect(inv(BUILD_RUN, { repository: 'acme/site', task: 'x', workspace: '0x' + 'a'.repeat(40) }, {} as never)).rejects.toThrow(/mandate is/);
    await expect(inv(BUILD_RUN, { repository: 'not-a-repo', task: 'x', workspace: ORG }, {} as never)).rejects.toThrow(/owner\/name/);
    expect(calls).toHaveLength(0);
  });
  it('no service configured ⇒ a stated refusal; a service failure is said, never dressed as a build', async () => {
    const none = buildInvoker({ env: {} }, { wire: { delegator: ORG } }, ORG);
    expect(((await none(BUILD_RUN, { repository: 'a/b', task: 'x', workspace: ORG }, {} as never)) as { refused: string }).refused).toMatch(/no Build service/);
    const bad = buildInvoker({ env, fetch: service([], 502) }, { wire: { delegator: ORG } }, ORG);
    const r = (await bad(BUILD_RUN, { repository: 'a/b', task: 'x', workspace: ORG }, {} as never)) as { built?: boolean; refused: string };
    expect(r.built).toBeUndefined(); expect(r.refused).toMatch(/429/);
  });
  it('the declared effect lands the artifact in the WORKSPACE\'s vault as build.run:<id>, field names the T-box\'s', async () => {
    const writes: Array<{ subject: string; key: string; record: Record<string, unknown> }> = [];
    const sink = declaredEffectSink({ writeSubjectRecord: async (subject, key, record) => { writes.push({ subject, key, record: record as Record<string, unknown> }); return { ok: true }; } }, {});
    const inv = buildInvoker({ env, fetch: service([]), resolveName: async (n) => (n === 'missio nexus' ? ORG : null) }, { wire: { delegator: ORG } }, ORG);
    const result = await inv(BUILD_RUN, { repository: 'acme/site', task: 'add CONTRIBUTING.md', workspace: 'missio nexus' }, {} as never);
    await sink.discharge({ runRef: 'run-1', stepRef: 's1', effect: { on: 'success', produces: 'BuildArtifact', recipientArg: 'workspace', deliverTo: ['workspace'], surface: ['record', 'thread'] }, step: { args: { workspace: 'missio nexus' } }, result, receipt: { authority: { presentedRef: '0xabc' } } } as never);
    expect(writes).toHaveLength(1); expect(writes[0]!.subject).toBe(ORG); expect(writes[0]!.key).toBe('build.run:build-1');
    expect(writes[0]!.record).toMatchObject({ type: 'ap.build-artifact.v1', workspace: ORG, repository: 'acme/site', base: 'main', evidence: { command: 'git status --short', exitCode: 0 }, model: 'xai/grok-4.20-0309-non-reasoning', runRef: 'run-1', mandateRef: '0xabc' });
  });
  it('build.run.list reads the workspace\'s records, newest first, filtered by repository', async () => {
    const rec = (id: string, repo: string, at: string) => ({ type: 'ap.build-artifact.v1', runId: id, workspace: ORG, repository: repo, base: 'main', task: 't', summary: 's', files: [{ path: 'a', content: '' }], evidence: { command: 'npm test', exitCode: 1, ran: true, outputTail: '', durationMs: 1 }, model: 'm', digest: 'd', runRef: 'r', mandateRef: null, builtAt: at });
    const inv = buildInvoker({ env, survey: async () => [{ recordType: 'build.run:b1', updatedAt: '2026-09-14' }, { recordType: 'build.run:b2', updatedAt: '2026-09-15' }, { recordType: 'inbox.data' }], readRecords: async (_s, keys) => Object.fromEntries(keys.map((k) => [k, k === 'build.run:b1' ? rec('b1', 'acme/site', '2026-09-14T00:00:00Z') : rec('b2', 'acme/docs', '2026-09-15T00:00:00Z')])) }, null, ORG);
    const all = (await inv(BUILD_RUN_LIST, { workspace: ORG }, {} as never)) as { runs: Array<{ runId: string; evidence: { exitCode: number } }> };
    expect(all.runs.map((r) => r.runId)).toEqual(['b2', 'b1']); expect(all.runs[0]!.evidence.exitCode).toBe(1);
    const one = (await inv(BUILD_RUN_LIST, { workspace: ORG, repository: 'acme/site' }, {} as never)) as { runs: Array<{ runId: string }> };
    expect(one.runs.map((r) => r.runId)).toEqual(['b1']);
  });
});

describe('B2 · B4 · B5 — an archive under the workspace\'s credential, review with evidence apart from assertion, promotion bound to the tuple', () => {
  const ORG_NAME = 'missio-nexus.org';
  const record = { type: 'ap.build-artifact.v1', runId: 'build-1', workspace: ORG, repository: 'acme/site', base: 'main', task: 'add CONTRIBUTING.md', summary: 'Added it and tests pass.', files: [{ path: 'CONTRIBUTING.md', content: '# C\n' }], evidence: { command: 'git status --short', exitCode: 0, ran: true, outputTail: '?? CONTRIBUTING.md', durationMs: 1 }, model: 'xai/grok', digest: 'sha256:abc', runRef: 'run-1', mandateRef: null, builtAt: '2026-09-16T00:00:00Z' };
  const PR = { number: 7, title: 'C', state: 'open', merged: false, mergeable: true, html_url: 'https://gh/acme/site/pull/7', head: { ref: 'build/build-1', sha: 'deadbeefcafe0000' }, body: `add\n\nrecord build.run:build-1\n\n---\nap:intent=0x${'a'.repeat(64)} ap:run=run-1\n`, comments: 0 };
  /** GitHub + the Build service behind one fetch: the tarball 302s to codeload; PRs list; checks; merge. */
  const forge = (calls: string[], opts: { checks?: Array<{ name: string; status: string; conclusion: string | null }>; merged?: boolean } = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); calls.push(`${init?.method ?? 'GET'} ${u}`);
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (u.endsWith('/commits/main')) return new Response(JSON.stringify({ sha: 'basebase0000' }));
    if (u.includes('/tarball/main')) { if (auth !== 'Bearer ghp_token') return new Response('', { status: 404 }); return new Response('', { status: 302, headers: { location: 'https://codeload.example/x.tgz?token=presigned' } }); }
    if (u.startsWith('https://codeload.example/')) { if (auth) throw new Error('the header rode the second hop'); return new Response(new Uint8Array([1, 2, 3, 4])); }
    if (u.includes('build.example/runs')) { const b = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ok: true, artifact: { ...artifact, source: b.archive ? 'archive' : 'clone', commit: b.archive?.commit } })); }
    if (/\/pulls\?state=all/.test(u)) return new Response(JSON.stringify([{ number: 9, body: 'other' }, { number: 7, body: PR.body }]));
    if (u.endsWith('/pulls/7')) return new Response(JSON.stringify({ ...PR, merged: opts.merged ?? false }));
    if (u.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: opts.checks ?? [{ name: 'ci', status: 'completed', conclusion: 'success' }] }));
    if (u.endsWith('/pulls/7/reviews')) return new Response(JSON.stringify([{ user: { login: 'alice' }, state: 'APPROVED' }]));
    if (u.endsWith('/pulls/7/merge') && init?.method === 'PUT') return new Response(JSON.stringify({ merged: true, sha: 'mergemerge0000' }));
    return new Response(JSON.stringify({ message: `unexpected ${u}` }), { status: 500 });
  }) as unknown as typeof fetch;
  const envWithForge = { ...env, AP_CONNECTOR_GITHUB_TOKEN_MISSIO_NEXUS_ORG: 'ghp_token' } as never;
  const nameOf = async () => ORG_NAME;

  it('B2: with the workspace\'s connector the repository reaches the service as an ARCHIVE fetched here — the credential is on the API hop only, never the codeload hop, never the sandbox', async () => {
    const calls: string[] = [];
    const inv = buildInvoker({ env: envWithForge, fetch: forge(calls), nameOf }, { wire: { delegator: ORG } }, ORG);
    const r = (await inv(BUILD_RUN, { repository: 'acme/site', task: 'x', workspace: ORG }, {} as never)) as { built: boolean; source: string; baseCommit: string };
    expect(r.built).toBe(true); expect(r.source).toBe('archive'); expect(r.baseCommit).toBe('basebase0000');
    const runCall = calls.find((c) => c.includes('build.example/runs'))!; expect(runCall).toBeTruthy();
    expect(calls.some((c) => c.includes('/tarball/main'))).toBe(true); expect(calls.some((c) => c.startsWith('GET https://codeload.example/'))).toBe(true);
  });
  it('B4: build.review returns the recorded evidence APART from the model\'s assertion, and the forge\'s checks on the PR opened from the run', async () => {
    const inv = buildInvoker({ env: envWithForge, fetch: forge([]), nameOf, readSubjectRecord: async (s, k) => (s === ORG && k === 'build.run:build-1' ? record : null) }, null, ORG);
    const r = (await inv('build.review', { runId: 'build-1', workspace: ORG }, {} as never)) as { evidence: { exitCode: number; recorded: boolean }; assertion: { summary: string; note: string }; pullRequest: { number: number; headSha: string; checksVerdict: string }; ready: boolean; answer: string };
    expect(r.evidence).toMatchObject({ exitCode: 0, recorded: true }); expect(r.assertion.summary).toContain('tests pass'); expect(r.assertion.note).toMatch(/assertion, apart from the evidence/);
    expect(r.pullRequest).toMatchObject({ number: 7, headSha: 'deadbeefcafe0000', checksVerdict: 'pass' }); expect(r.ready).toBe(true);
    expect(r.answer).toMatch(/The model asserts:/); expect(r.answer).toMatch(/Recorded evidence:/);
  });
  it('B5: build.promote merges only under a mandate whose ask names the run AND the commit at the PR head; a wrong commit or an ask without them is refused; the tuple is recorded', async () => {
    const writes: Array<{ key: string; record: Record<string, unknown> }> = [];
    const deps = { env: envWithForge, fetch: forge([]), nameOf, readSubjectRecord: async (s: string, k: string) => (s === ORG && k === 'build.run:build-1' ? record : null), writeSubjectRecord: async (_s: string, key: string, rec: unknown) => { writes.push({ key, record: rec as Record<string, unknown> }); return { ok: true }; } };
    const inv = buildInvoker(deps, { wire: { delegator: ORG } }, ORG);
    const wrong = (await inv('build.promote', { runId: 'build-1', commit: 'aaaaaaa', workspace: ORG }, { intent: { goal: 'promote build-1 aaaaaaa' } } as never)) as { refused: string };
    expect(wrong.refused).toMatch(/the tuple names commit aaaaaaa/);
    await expect(inv('build.promote', { runId: 'build-1', commit: 'deadbeef', workspace: ORG }, { intent: { goal: 'ship it' } } as never)).rejects.toThrow(/must name the build run/);
    const ok = (await inv('build.promote', { runId: 'build-1', commit: 'deadbeef', workspace: ORG }, { intent: { goal: 'promote build build-1 at commit deadbeef' }, runRef: 'run-9' } as never)) as { promoted: boolean; mergeSha: string; tuple: { commit: string; environment: string; migration: string }; record: string };
    expect(ok.promoted).toBe(true); expect(ok.mergeSha).toBe('mergemerge0000'); expect(ok.tuple).toEqual({ commit: 'deadbeefcafe0000', configDigest: 'sha256:abc', environment: 'branch:main', migration: 'none' }); expect(ok.record).toBe('build.promotion:build-1');
    expect(writes[0]!.record).toMatchObject({ type: 'ap.build-promotion.v1', pullRequest: 7, commit: 'deadbeefcafe0000', runRef: 'run-9' });
  });
  it('B5 twin: failing checks refuse the promotion before the forge merges; no PR from the run refuses', async () => {
    const calls: string[] = [];
    const inv = buildInvoker({ env: envWithForge, fetch: forge(calls, { checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }), nameOf, readSubjectRecord: async () => record, writeSubjectRecord: async () => ({ ok: true }) }, { wire: { delegator: ORG } }, ORG);
    await expect(inv('build.promote', { runId: 'build-1', commit: 'deadbeef', workspace: ORG }, { intent: { goal: 'promote build-1 deadbeef' } } as never)).rejects.toThrow(/checks failing/);
    expect(calls.some((c) => c.startsWith('PUT') && c.endsWith('/merge'))).toBe(false);
    const none = buildInvoker({ env, nameOf, readSubjectRecord: async () => record }, { wire: { delegator: ORG } }, ORG);
    expect(((await none('build.promote', { runId: 'build-1', commit: 'deadbeef', workspace: ORG }, { intent: { goal: 'promote build-1 deadbeef' } } as never)) as { refused: string }).refused).toMatch(/no GitHub connector/);
  });
});
