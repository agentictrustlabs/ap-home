'use client';
// THREE STORES, NEVER ONE LABEL — spec 398 §6.1. Three tabs, each headed by WHOSE vault holds it: PERSONAL (the person's
// remembered choices and standing instructions — forget here; a receipt that cited the fact keeps its citation),
// WORKSPACE (the organization's / service's endeavor context and Library — who can see each), RUN (the acting agent's
// checkpoints and run records — ephemeral by default; promotion to the Library is an act, not yet offered). A personal
// fact never becomes workspace knowledge without a sharing act that leaves a record (T14). What each store does not show
// yet is said in the view.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { listConfirmations, listInstructions, forgetConfirmation, forgetInstruction, listRuns, listRunRecords, type RememberedChoice, type StandingInstruction, type ParkedRun, type RunRecordRow } from '../../home/ask';
import { fetchWorkList, type EndeavorRow } from '../../lib/work-client';
import { assembleMemory, type MemoryItem, type MemoryStore } from '../../home/memory';
import type { TodayArtifact } from '../../home/today';
import { StatePill } from './StatePill';
import { AgentName } from '../shared/AgentName';
import { workspaceHref, type WorkspaceScope } from '../../lib/workspace';
import { List, Row, Empty, Unknown, ErrorNote, Meta, Micro, Note, Button, LinkButton } from '../../ui';

const STORES: Array<{ id: MemoryStore; label: string; owner: string; hint: string }> = [
  { id: 'personal', label: 'Personal', owner: 'your vault', hint: 'facts about you that your agent keeps: which "David", which treasury pays. Yours to correct or forget.' },
  { id: 'workspace', label: 'Workspace', owner: "the workspace's vault", hint: 'what the organization or service holds as shared knowledge: its endeavors, its Library — and who may see each.' },
  { id: 'run', label: 'Run', owner: "the acting agent's vault", hint: 'what a run left behind: unfinished asks, records, provenance. Ephemeral by default; a week, then gone.' },
];

export function MemoryViews({ scope }: { scope: WorkspaceScope }) {
  const { session, agentAddress } = useSession();
  const self = (agentAddress ?? '').toLowerCase();
  const workspace = scope.kind === 'org' ? scope.org.toLowerCase() : scope.kind === 'service' ? scope.agent.toLowerCase() : self;
  const [tab, setTab] = useState<MemoryStore>(scope.kind === 'person' ? 'personal' : 'workspace');
  const [confirmations, setConfirmations] = useState<RememberedChoice[]>([]);
  const [instructions, setInstructions] = useState<StandingInstruction[]>([]);
  const [endeavors, setEndeavors] = useState<EndeavorRow[]>([]);
  const [artifacts, setArtifacts] = useState<Array<TodayArtifact & { releases?: number; grants?: number }>>([]);
  const [records, setRecords] = useState<RunRecordRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<Array<ParkedRun & { state?: string }>>([]);
  const [loaded, setLoaded] = useState(false);
  // 398 §6.3 — which reads failed, by store: an empty tab is never shown for a read that did not happen.
  const [unknown, setUnknown] = useState<Partial<Record<MemoryStore, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session || !self) return;
    const token = session.token;
    const why = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'unreachable';
    const u: Partial<Record<MemoryStore, string>> = {};
    const [c, s, runs, recs] = await Promise.all([
      listConfirmations({ token }).catch((e) => { u.personal = `remembered choices: ${why(e)}`; return []; }), listInstructions({ token }).catch((e) => { u.personal = `standing instructions: ${why(e)}`; return []; }),
      listRuns({ token }, workspace as Address).catch((e) => { u.run = `checkpoints: ${why(e)}`; return []; }), listRunRecords({ token }, workspace as Address).then((r) => r.records).catch((e) => { u.run = `run records: ${why(e)}`; return []; }),
    ]);
    setConfirmations(c); setInstructions(s); setCheckpoints(runs as never); setRecords(recs);
    if (scope.kind === 'org') { const w = await fetchWorkList(token, workspace).catch((e) => { u.workspace = `the work list: ${why(e)}`; return null; }); setEndeavors(w?.endeavors ?? []); }
    const scopeQ = scope.kind === 'person' ? '' : `?org=${workspace}`;
    const lib = await fetch(`/connect/library${scopeQ}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => { if (!r.ok) throw new Error(`the Library answered ${r.status}`); return r.json(); }).catch((e) => { u.workspace = [u.workspace, `the Library: ${why(e)}`].filter(Boolean).join('; '); return { artifacts: [] }; }) as { artifacts?: Array<{ id: string; name: string; kind?: string; createdAt?: number; version?: number; isFolder?: boolean; releases?: unknown[]; grants?: unknown[] }> };
    setArtifacts((lib.artifacts ?? []).filter((a) => !a.isFolder && typeof a.createdAt === 'number').map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt as number, ...(a.kind ? { kind: a.kind } : {}), ...(a.version ? { version: a.version } : {}), ...(a.releases?.length ? { releases: a.releases.length } : {}), ...(a.grants?.length ? { grants: a.grants.length } : {}) })));
    setUnknown(u);
    setLoaded(true);
  }, [session?.token, self, workspace, scope.kind]);
  useEffect(() => { void load(); }, [load]);

  const views = useMemo(() => assembleMemory({ self, workspace, confirmations, instructions, endeavors, artifacts, records, checkpoints }), [self, workspace, confirmations, instructions, endeavors, artifacts, records, checkpoints]);

  const forget = async (it: MemoryItem) => {
    if (!session || !it.ref) return;
    setBusy(it.id); setErr(null);
    const out = it.kind === 'remembered choice'
      ? await forgetConfirmation(session, it.ref as { word: string; capability: string; arg: string; context?: string })
      : await forgetInstruction(session, it.ref as { context: string; capability: string; arg: string });
    setBusy(null);
    if (!out.ok) { setErr(out.error); return; }
    await load();
  };
  const hrefOf = (it: MemoryItem): string | undefined => {
    if (it.id.startsWith('endeavor:')) return `/org/${workspace}/work/${encodeURIComponent(it.id.slice('endeavor:'.length))}`;
    if (it.id.startsWith('artifact:')) return `${workspaceHref(scope, 'library')}?open=${encodeURIComponent(it.id.slice('artifact:'.length))}`;
    if (it.id.startsWith('checkpoint:')) return `/ask?seed=${encodeURIComponent(it.title)}`;
    if (it.id.startsWith('record:')) return workspaceHref(scope, 'activities');
    return undefined;
  };
  const items = views[tab];
  const meta = STORES.find((s) => s.id === tab)!;
  if (!session) return null;
  return (
    <div data-testid="memory-views">
      <div className="ui-toolbar">
        <div className="ui-tabs" role="tablist" aria-label="Which store">
          {STORES.map((s) => (
            <button key={s.id} type="button" role="tab" className="ui-tab" aria-selected={tab === s.id} data-testid={`memory-${s.id}`} onClick={() => setTab(s.id)}>
              {s.label}<span className="ui-count">{views[s.id].length}</span>
            </button>
          ))}
        </div>
      </div>
      <Note>
        <strong style={{ color: 'var(--color-text-body)' }}>{meta.owner}</strong> — {meta.hint}
        {tab === 'personal' && ' Forgetting a fact does not unwrite a receipt that cited it: the receipt stays, the fact is no longer used.'}
        {tab === 'run' && ' Promotion to the Library is an act with a receipt, never a drag.'}
      </Note>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!loaded && <Meta>Reading…</Meta>}
      {unknown[tab] && <Unknown read={unknown[tab]} partial={items.length > 0} testId="memory-unknown" />}
      {loaded && items.length === 0 && !unknown[tab] && <Empty>Nothing here yet.</Empty>}
      {items.length > 0 && (
        <List>
          {items.map((it) => {
            const href = hrefOf(it);
            return (
              <Row
                key={it.id}
                title={it.title} {...(href ? { titleHref: href } : {})}
                meta={<>{it.kind} · <AgentName address={it.owner} />{it.visibility ? ` · ${it.visibility}` : ''}{it.detail ? ` · ${it.detail}` : ''}</>}
                side={<>
                  {it.state && <StatePill state={it.state} {...(it.native ? { native: it.native } : {})} compact />}
                  {it.at && <span className="ui-row-time">{new Date(it.at).toLocaleDateString()}</span>}
                  {it.actions.includes('correct') && <LinkButton size="sm" variant="ghost" href={`/ask?seed=${encodeURIComponent(`${it.title} — change that`)}`} title="Correct it by choosing differently: a new confirmation replaces the old">Correct</LinkButton>}
                  {it.actions.includes('forget') && <Button size="sm" variant="ghost" disabled={busy === it.id} onClick={() => void forget(it)} data-testid="memory-forget">{busy === it.id ? 'Forgetting…' : 'Forget'}</Button>}
                  {it.actions.includes('promote') && <Micro>promote: not yet</Micro>}
                </>}
                testId="memory-item"
              />
            );
          })}
        </List>
      )}
      {views.absent[tab].length > 0 && (
        <p className="ui-micro" style={{ marginTop: 'var(--sp-3)' }}>Not shown here yet: {views.absent[tab].join(' · ')}</p>
      )}
    </div>
  );
}
