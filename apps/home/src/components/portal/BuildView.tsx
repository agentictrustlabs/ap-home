'use client';
// BUILD — spec 398 §9 / ap-build B3. What the workspace's agent BUILT: each run a record in the organization's vault
// (the files the model wrote, the test evidence as RECORDED — the command and its exit code, never "tests pass"),
// and a task to run next. The screen executes nothing: the task is handed to the Ask as `build.run` (spec 361 I4),
// where the organization's steward signs the mandate; the Build service runs it in a sandbox; the reply proposes the
// pull request as a separate act. A build never deploys (T29) — promotion is its own signature, later.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { PageHead, Section, List, Row, Card, Empty, ErrorNote, Note, Button, Chip, Mono, Meta, SkeletonRows } from '../../ui';
import { askCommand } from '../../home/ask-command';
import { listBuildRuns, type BuildRunRow } from '../../home/ask';

const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const lastCmd = (c: string) => c.split(';').pop()?.trim() ?? c;

export function BuildView({ org }: { org: Address }) {
  const { session } = useSession();
  const [runs, setRuns] = useState<BuildRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repository, setRepository] = useState('');
  const [base, setBase] = useState('');
  const [task, setTask] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    const r = await listBuildRuns({ token: session.token }, org);
    if (r.ok) setRuns(r.runs); else { setRuns([]); setError(r.error); }
  }, [session, org]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onDone = () => { void load(); };
    window.addEventListener('ap:ask-done', onDone);
    return () => window.removeEventListener('ap:ask-done', onDone);
  }, [load]);

  const repoOk = /^[\w.-]+\/[\w.-]+$/.test(repository.trim());
  const run = () => {
    if (!repoOk || !task.trim()) return;
    askCommand({ toolId: 'build.run', args: { workspace: org, repository: repository.trim(), task: task.trim(), ...(base.trim() ? { base: base.trim() } : {}) }, message: `in ${repository.trim()}${base.trim() ? `@${base.trim()}` : ''}: ${task.trim()}` });
  };
  const again = (r: BuildRunRow) => { setRepository(r.repository); setBase(r.base === 'main' ? '' : r.base); setTask(r.task); };

  return (
    <>
      <PageHead title="Build" description="What this workspace's agent built — each run in a sandbox, its files and its test evidence as recorded. A build never deploys." />
      <Card title="Run a build task" testId="build-task-form">
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
          <label style={{ display: 'grid', gap: 4 }}><Meta>Repository</Meta><input id="build-repository" className="ui-input" placeholder="owner/name (public)" value={repository} onChange={(e) => setRepository(e.target.value)} data-testid="build-repository" /></label>
          <label style={{ display: 'grid', gap: 4 }}><Meta>Branch</Meta><input id="build-base" className="ui-input" placeholder="main" value={base} onChange={(e) => setBase(e.target.value)} data-testid="build-base" /></label>
        </div>
        <label style={{ display: 'grid', gap: 4, marginTop: 8 }}><Meta>Task — in your words</Meta><textarea id="build-task" className="ui-input" rows={3} placeholder="add a CONTRIBUTING.md that says every change here is a pull request opened by an agent under a mandate" value={task} onChange={(e) => setTask(e.target.value)} data-testid="build-task" /></label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={run} disabled={!repoOk || !task.trim()} data-testid="build-run">Build under the workspace&rsquo;s mandate</Button>
          <Meta>The Ask runs it: you sign as the steward, the sandbox builds, the reply offers the pull request.</Meta>
        </div>
      </Card>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Section title="Build runs" count={runs?.length} testId="build-runs">
        {runs === null ? <SkeletonRows rows={2} lead /> : runs.length === 0 ? <Empty title="Nothing built yet">A build run leaves its files and its recorded evidence here, in the workspace&rsquo;s own records.</Empty> : (
          <List>
            {runs.map((r) => (
              <Row key={r.runId} testId="build-run-row"
                title={<span>{r.repository}{r.base !== 'main' ? <Mono>@{r.base}</Mono> : null} — {r.task.length > 110 ? `${r.task.slice(0, 110)}…` : r.task}</span>}
                meta={<span>{r.summary ? `${r.summary} · ` : ''}{r.files.length} file{r.files.length === 1 ? '' : 's'}: {r.files.join(', ')} · {r.model} · {when(r.builtAt)}</span>}
                side={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <Chip tone={r.evidence.exitCode === 0 ? 'ok' : 'danger'} title={r.evidence.command}>{lastCmd(r.evidence.command)} · exit {r.evidence.exitCode}</Chip>
                  <Mono title={r.record}>{r.runId}</Mono>
                  <Button size="sm" onClick={() => again(r)}>Again</Button>
                </span>} />
            ))}
          </List>
        )}
      </Section>
      <Note>Evidence is what RAN — the repository&rsquo;s test script when it has one, else a syntax check of what changed — with its exit code. A pull request opened from a run names the run; merging it is a promotion, a steward&rsquo;s own signature.</Note>
    </>
  );
}
