'use client';
// TODAY — spec 398 §4.2, the first page of every workspace. Outcome-led, in a FIXED order: decisions awaiting me →
// active goals → recent artifacts → routine exceptions → one suggested next act. Nothing here executes: an approval is
// signed where approvals are signed. The assembly is `src/home/today.ts` (pure, table-tested); this component fetches
// and renders on the UI system v2: a strip of the day's numbers, then one PANEL per block, each in ONE state — a
// skeleton while its read is out, the rows once it answered, a fact when there is nothing, the failed read named.
import { useMemo } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { assembleToday, type Today, type TodayItem } from '../../home/today';
import { useTodayReads } from '../../home/use-today-inputs';
import { useMyWork } from './work/useWork';
import { RunControls } from './runs/RunControls';
import { workspaceHref, type WorkspaceScope } from '../../lib/workspace';
import { List, Row, Panel, Stats, Stat, relativeLabel, type PanelState } from '../../ui';
import { TodayCalendar } from './TodayCalendar';
import { TodayMemory } from './TodayMemory';
import { StatePill } from './StatePill';
import { AlertIcon, ActivityIcon, FileIcon, RepeatIcon, SparkIcon } from './today-icons';

const RECENT_DAYS = 7;

type CardCtx = { token: string; addressee: Address; onCanceled: (runRef: string) => void };

function ItemRow({ item, ctx, cta }: { item: TodayItem; ctx?: CardCtx; cta?: string }) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  const side = (
    <>
      {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} compact />}
      {item.at && <span className="ui-row-time" title={new Date(item.at).toLocaleString()}>{relativeLabel(item.at)}</span>}
      {item.runRef && ctx && <RunControls token={ctx.token} addressee={ctx.addressee} runRef={item.runRef} compact onCanceled={() => ctx.onCanceled(item.runRef!)} />}
      {cta && href && !item.runRef && <a className="ui-btn ui-btn--secondary ui-btn--sm" href={href}>{cta}</a>}
    </>
  );
  // a row with a control on it is not itself a link (a button inside an anchor is two clicks fighting): the title links
  return item.runRef || cta
    ? <Row title={item.title} meta={item.detail} side={side} {...(href ? { titleHref: href } : {})} testId="today-card" />
    : <Row title={item.title} meta={item.detail} side={side} {...(href ? { href } : {})} testId="today-card" />;
}

function stateOf(loading: boolean, failed: string | undefined, count: number): PanelState {
  if (loading) return 'loading';
  if (failed) return 'unknown';
  return count ? 'ready' : 'empty';
}

/** Which agent Today is ABOUT: the person's own, or the workspace's organization / service. */
function addresseeOf(scope: WorkspaceScope, self: string | null | undefined): string | null {
  if (scope.kind === 'org') return scope.org.toLowerCase();
  if (scope.kind === 'service') return scope.agent.toLowerCase();
  return self ? self.toLowerCase() : null;
}

export function TodayView({ scope, children }: { scope: WorkspaceScope; children?: React.ReactNode }) {
  const { session, agentAddress } = useSession();
  const addressee = addresseeOf(scope, agentAddress);
  const { bundles } = useMyWork(session, agentAddress);
  const { parked, triggers, vocabulary, artifacts, records, failed, pending, dropRun } = useTodayReads(session?.token, addressee, scope.kind === 'person' ? 'person' : 'other');
  const workLoading = scope.kind !== 'service' && bundles === null;

  const today: Today | null = useMemo(() => {
    if (parked === null) return null;
    const mine = scope.kind === 'org' ? (bundles ?? []).filter((b) => b.org.toLowerCase().endsWith(scope.org.toLowerCase())) : scope.kind === 'service' ? [] : bundles;
    return assembleToday({ now: Date.now(), parked, bundles: mine, artifacts, triggers, vocabulary, records, recentDays: RECENT_DAYS });
  }, [parked, bundles, artifacts, triggers, vocabulary, records, scope]);

  const ctx: CardCtx | undefined = addressee ? { token: session?.token ?? '', addressee: addressee as Address, onCanceled: dropRun } : undefined;
  const libraryHref = workspaceHref(scope, 'library');
  const playbookHref = workspaceHref(scope, 'playbook');
  const workHref = workspaceHref(scope, 'work');
  if (!session) return null;

  const decisions = today?.decisions ?? []; const active = today?.active ?? []; const arts = today?.artifacts ?? []; const exceptions = today?.exceptions ?? [];
  const decisionsState = stateOf(pending.runs || workLoading, failed.runs, decisions.length);
  const activeState = stateOf(pending.runs || workLoading, failed.runs, active.length);
  const artifactsState = stateOf(pending.artifacts, failed.artifacts, arts.length);
  const exceptionsState = stateOf(pending.triggers, failed.triggers, exceptions.length);
  const nextState: PanelState = pending.vocabulary || pending.runs ? 'loading' : today?.next ? 'ready' : 'empty';
  const cost = today?.cost;

  return (
    <div className="today" data-testid="today">
      <Stats>
        <Stat label="Needs you" value={decisions.length} loading={decisionsState === 'loading'} tone={decisions.length ? 'warn' : undefined} hint={decisions.length ? 'decisions waiting for your signature' : 'nothing waiting on you'} href="#today-decisions" />
        <Stat label="In motion" value={active.length} loading={activeState === 'loading'} hint={active.length ? 'goals running or queued' : 'nothing running'} href={workHref} />
        <Stat label="New in the Library" value={arts.length} loading={artifactsState === 'loading'} hint={`last ${RECENT_DAYS} days`} href={libraryHref} />
        <Stat label="Routine exceptions" value={exceptions.length} loading={exceptionsState === 'loading'} tone={exceptions.length ? 'danger' : 'ok'} hint={exceptions.length ? 'a routine did not go through' : 'every routine went through'} href={playbookHref} />
      </Stats>

      <div id="today-decisions" />
      <Panel title="Needs your decision" icon={<AlertIcon />} count={decisions.length} state={decisionsState} rows={2} testId="today-needs-your-decision"
        empty={{ icon: <AlertIcon />, title: 'Nothing is waiting on you', hint: 'When a run needs your signature or an answer, it appears here first.' }}
        unknown={{ read: `your unfinished asks could not be read (${failed.runs})`, partial: decisions.length > 0 }}>
        <List>{decisions.map((it) => <ItemRow key={it.id} item={it} {...(ctx ? { ctx } : {})} cta="Decide" />)}</List>
      </Panel>

      <Panel title="Active goals" icon={<ActivityIcon />} count={active.length} state={activeState} rows={3} testId="today-active-goals" aside={<a href={workHref}>Open Work →</a>}
        empty={{ icon: <ActivityIcon />, title: 'Nothing in motion', hint: 'Ask for something, or take on a piece of work.', action: <a className="ui-btn ui-btn--secondary ui-btn--sm" href="/ask">Ask your agent</a> }}
        unknown={{ read: `your unfinished asks could not be read (${failed.runs})`, partial: active.length > 0 }}>
        <List>{active.map((it) => <ItemRow key={it.id} item={it} {...(ctx ? { ctx } : {})} />)}</List>
      </Panel>

      {scope.kind === 'person' && addressee && <TodayCalendar person={addressee as Address} />}
      {scope.kind === 'person' && <TodayMemory />}

      <Panel title="Recent artifacts" icon={<FileIcon />} count={arts.length} state={artifactsState} rows={2} testId="today-recent-artifacts" aside={<a href={libraryHref}>Open the Library →</a>}
        empty={{ icon: <FileIcon />, title: `Nothing new in the last ${RECENT_DAYS} days`, hint: 'Artifacts your runs produce land in the Library and show here.' }}
        unknown={{ read: `the Library could not be read (${failed.artifacts})`, partial: arts.length > 0 }}>
        <List>{arts.map((it) => <ItemRow key={it.id} item={it} />)}</List>
      </Panel>

      <Panel title="Routine exceptions" icon={<RepeatIcon />} count={exceptions.length} state={exceptionsState} rows={2} testId="today-routine-exceptions" aside={<a href={playbookHref}>Playbook →</a>}
        empty={{ icon: <RepeatIcon />, title: 'Every routine went through', hint: 'A routine whose last firing failed or parked shows here.' }}
        unknown={{ read: `the schedule could not be read (${failed.triggers})`, partial: exceptions.length > 0 }}>
        <List>{exceptions.map((it) => <ItemRow key={it.id} item={it} />)}</List>
      </Panel>

      <Panel title="Next" icon={<SparkIcon />} state={nextState} rows={1} testId="today-next"
        aside={<span data-testid="today-cost">{cost
          ? <>last {cost.days} days · {cost.runs} run{cost.runs === 1 ? '' : 's'} · {cost.vaultCalls} vault call{cost.vaultCalls === 1 ? '' : 's'} · {cost.doRequests} serving request{cost.doRequests === 1 ? '' : 's'}</>
          : failed.records ? <span style={{ color: 'var(--st-warn-fg)' }}>cost unknown — the records could not be read ({failed.records})</span> : <>no run in the last {RECENT_DAYS} days carries a bill</>}</span>}
        empty={{ icon: <SparkIcon />, title: 'Nothing to suggest yet', hint: 'A playbook gives your agent something to offer.', action: <a className="ui-btn ui-btn--secondary ui-btn--sm" href={playbookHref}>Choose a playbook</a> }}>
        {today?.next && <List><ItemRow item={today.next} cta="Start" /></List>}
      </Panel>
      {children}
    </div>
  );
}
