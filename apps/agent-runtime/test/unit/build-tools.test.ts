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
