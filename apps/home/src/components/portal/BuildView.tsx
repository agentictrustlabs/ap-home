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
import { listBuildRuns, listRepositories, listBranches, type BuildRunRow, type RepositoryRow } from '../../home/ask';

const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const lastCmd = (c: string) => c.split(';').pop()?.trim() ?? c;

export function BuildView({ org }: { org: Address }) {
  const { session } = useSession();
  const [runs, setRuns] = useState<BuildRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repository, setRepository] = useState('');
  const [base, setBase] = useState('');
  const [task, setTask] = useState('');
  // THE PICKER'S LISTS come from the workspace's own forge connector, through the Ask (`github.repos.list`,
  // `github.repo.read`) — the repositories its credential can write to, which are exactly the ones a submission could
  // land on. `other` lets a public repository outside them be typed: it builds, and the PR step says why it cannot.
  const [repos, setRepos] = useState<RepositoryRow[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [branches, setBranches] = useState<{ repo: string; defaultBranch: string; list: string[] } | null>(null);
  const [branchesBusy, setBranchesBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    const r = await listBuildRuns({ token: session.token }, org);
    if (r.ok) setRuns(r.runs); else { setRuns([]); setError(r.error); }
  }, [session, org]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    void listRepositories({ token: session.token }, org).then((r) => { if (!live) return; if (r.ok) { setRepos(r.repositories); if (!r.repositories.length) setOther(true); } else { setRepos([]); setReposError(r.error); setOther(true); } });
    return () => { live = false; };
  }, [session, org]);
  // Branches follow the picked repository (only for one the connector lists; a typed one keeps the default branch).
  useEffect(() => {
    if (!session || other || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) { setBranches(null); return; }
    let live = true; setBranchesBusy(true);
    void listBranches({ token: session.token }, org, repository).then((r) => { if (!live) return; setBranchesBusy(false); if (r.ok) { setBranches({ repo: repository, defaultBranch: r.defaultBranch, list: r.branches }); setBase((b) => (b && r.branches.includes(b) ? b : '')); } else setBranches(null); });
    return () => { live = false; };
  }, [session, org, repository, other]);
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
      <PageHead title="Build" description="What this workspace's agent built — each run in a sandbox, its files and its test evidence as recorded; review with the evidence; promote under a signature over the exact commit." />
      <Card title="Run a build task" testId="build-task-form">
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <Meta>Repository{repos && repos.length > 0 && !other ? ` · ${repos.length} the connector can write to` : ''}</Meta>
            {repos === null ? <select className="ui-input" disabled><option>Reading the connector’s repositories…</option></select>
              : other ? <input id="build-repository" className="ui-input" placeholder="owner/name (a public repository)" value={repository} onChange={(e) => setRepository(e.target.value)} data-testid="build-repository" />
              : <select id="build-repository" className="ui-input" value={repository} onChange={(e) => { if (e.target.value === '__other') { setOther(true); setRepository(''); setBase(''); } else setRepository(e.target.value); }} data-testid="build-repository">
                  <option value="">Pick a repository…</option>
                  {repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo}{r.private ? ' (private)' : ''}</option>)}
                  <option value="__other">Another public repository…</option>
                </select>}
            {other && repos && repos.length > 0 && <button type="button" className="ghost" style={{ justifySelf: 'start', display: 'inline', padding: 0, minHeight: 0, fontSize: 'var(--fs-sm)' }} onClick={() => { setOther(false); setRepository(''); setBase(''); }}>Back to the connector’s repositories</button>}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <Meta>Branch{branchesBusy ? ' · reading…' : ''}</Meta>
            {branches && branches.repo === repository && !other
              ? <select id="build-base" className="ui-input" value={base} onChange={(e) => setBase(e.target.value)} data-testid="build-base">
                  {branches.list.map((b) => <option key={b} value={b === branches.defaultBranch ? '' : b}>{b}{b === branches.defaultBranch ? ' (default)' : ''}</option>)}
                </select>
              : <input id="build-base" className="ui-input" placeholder="main" value={base} onChange={(e) => setBase(e.target.value)} data-testid="build-base" />}
          </label>
        </div>
        {reposError && <Meta>The connector’s repositories could not be read — {reposError}. A public repository can still be typed; the pull request needs a connector that can write to it.</Meta>}
        {other && !reposError && <Meta>A repository outside the connector’s list builds in the sandbox; the pull request step will say it cannot be opened there.</Meta>}
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
                  <Button size="sm" onClick={() => askCommand({ toolId: 'build.review', args: { workspace: org, runId: r.runId }, message: `review build ${r.runId}` })}>Review</Button>
                  <Button size="sm" onClick={() => again(r)}>Again</Button>
                </span>} />
            ))}
          </List>
        )}
      </Section>
      <Note>Evidence is what RAN — the repository&rsquo;s test script when it has one, else a syntax check of what changed — with its exit code. <strong>Review</strong> shows it apart from what the model claims, with the forge&rsquo;s checks on the pull request. A promotion (&ldquo;promote build &lt;run&gt; at commit &lt;sha&gt;&rdquo; in the Ask) is a steward&rsquo;s signature over that exact commit — the one act that reaches the branch. A private repository builds when the workspace holds a GitHub connector: its archive is fetched here, the sandbox never sees the credential.</Note>
    </>
  );
}
