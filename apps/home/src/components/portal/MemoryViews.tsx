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
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {STORES.map((s) => (
          <button key={s.id} type="button" className={`chat-rail-action${tab === s.id ? ' chat-rail-action--active' : ''}`} data-testid={`memory-${s.id}`} onClick={() => setTab(s.id)} style={{ fontWeight: tab === s.id ? 700 : 500 }}>
            {s.label} · {views[s.id].length}
          </button>
        ))}
      </div>
      <p className="manage-card-blurb" style={{ marginBottom: '0.6rem' }}>
        <strong>{meta.owner}</strong> — {meta.hint}
        {tab === 'personal' && ' Forgetting a fact does not unwrite a receipt that cited it: the receipt stays, the fact is no longer used.'}
        {tab === 'run' && ' Promotion to the Library is an act with a receipt, never a drag.'}
      </p>
      {err && <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{err}</p>}
      {!loaded && <p className="muted" style={{ fontSize: '0.8rem' }}>Reading…</p>}
      {unknown[tab] && <p style={{ fontSize: '0.78rem', color: 'var(--color-amber-700, #b45309)' }} data-testid="memory-unknown">unknown — {unknown[tab]}. {items.length ? 'What is shown is partial.' : 'Nothing is shown because it could not be read, not because nothing is there.'}</p>}
      {loaded && items.length === 0 && !unknown[tab] && <p className="muted" style={{ fontSize: '0.8rem' }}>Nothing here yet.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {items.map((it) => {
          const href = hrefOf(it);
          return (
            <div key={it.id} className="manage-card" style={{ padding: '0.6rem 0.85rem', display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }} data-testid="memory-item" data-kind={it.kind}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.7rem', opacity: 0.6 }}>{it.kind} · <AgentName address={it.owner} />{it.visibility ? ` · ${it.visibility}` : ''}</div>
                <div style={{ fontWeight: 600, fontSize: '0.86rem' }}>{href ? <a href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{it.title}</a> : it.title}</div>
                {it.detail && <div style={{ fontSize: '0.73rem', opacity: 0.65 }}>{it.detail}</div>}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {it.state && <StatePill state={it.state} {...(it.native ? { native: it.native } : {})} compact />}
                {it.at && <span style={{ fontSize: '0.7rem', opacity: 0.55 }}>{new Date(it.at).toLocaleDateString()}</span>}
                {it.actions.includes('correct') && <a className="btn-ghost" style={{ fontSize: '0.74rem' }} href={`/ask?seed=${encodeURIComponent(`${it.title} — change that`)}`} title="Correct it by choosing differently: a new confirmation replaces the old">Correct</a>}
                {it.actions.includes('forget') && <button type="button" className="btn-ghost" style={{ fontSize: '0.74rem' }} disabled={busy === it.id} onClick={() => void forget(it)} data-testid="memory-forget">{busy === it.id ? 'Forgetting…' : 'Forget'}</button>}
                {it.actions.includes('promote') && <span className="muted" style={{ fontSize: '0.7rem' }} title="Promotion to the Library is an act with a receipt — not offered here yet (398 §6.1)">promote: not yet</span>}
              </div>
            </div>
          );
        })}
      </div>
      {views.absent[tab].length > 0 && (
        <p className="muted" style={{ fontSize: '0.74rem', marginTop: '0.6rem' }}>Not shown here yet: {views.absent[tab].join(' · ')}</p>
      )}
    </div>
  );
}
