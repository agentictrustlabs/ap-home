'use client';
// TODAY — spec 398 §4.2, the first page of every workspace (the nav's first slot, 348's grammar kept). Outcome-led,
// in a FIXED order: decisions awaiting me → active goals → recent artifacts → routine exceptions → one suggested
// next act. No message counts, no infrastructure statistics. Every row points at the surface that owns the act
// (Work, the Ask, the Library, the Playbook) — nothing here executes: an approval is signed where approvals are
// signed. The assembly is `src/home/today.ts` (pure, table-tested); this component only fetches and renders, on the
// UI system: one section shape, one list of rows, an empty state that is a fact and an unknown state that is not.
import { useMemo } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../context/session';
import { assembleToday, type Today, type TodayItem } from '../../home/today';
import { useTodayReads } from '../../home/use-today-inputs';
import { useMyWork } from './work/useWork';
import { StatePill } from './StatePill';
import { RunControls } from './runs/RunControls';
import { workspaceHref, type WorkspaceScope } from '../../lib/workspace';
import { Section, List, Row, Empty, Unknown, Meta } from '../../ui';

const RECENT_DAYS = 7;

type CardCtx = { token: string; addressee: Address; onCanceled: (runRef: string) => void };

function ItemRow({ item, ctx }: { item: TodayItem; ctx?: CardCtx }) {
  const href = item.href ?? (item.askSeed ? `/ask?seed=${encodeURIComponent(item.askSeed)}` : undefined);
  const side = (
    <>
      {item.runRef && ctx && <RunControls token={ctx.token} addressee={ctx.addressee} runRef={item.runRef} compact onCanceled={() => ctx.onCanceled(item.runRef!)} />}
      {item.state && <StatePill state={item.state} {...(item.native ? { native: item.native } : {})} />}
      {item.at && <span className="ui-row-time">{new Date(item.at).toLocaleDateString()}</span>}
    </>
  );
  // a row with a control on it is not itself a link (a button inside an anchor is two clicks fighting): the title links
  return item.runRef
    ? <Row title={item.title} meta={item.detail} side={side} {...(href ? { titleHref: href } : {})} testId="today-card" />
    : <Row title={item.title} meta={item.detail} side={side} {...(href ? { href } : {})} testId="today-card" />;
}

function TodaySection({ title, items, empty, unknown, aside, ctx }: { title: string; items: TodayItem[]; empty: string; unknown?: string; aside?: React.ReactNode; ctx?: CardCtx }) {
  return (
    <Section title={title} count={items.length || undefined} aside={aside} testId={`today-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
      {unknown && <Unknown read={unknown} partial={items.length > 0} testId="today-unknown" />}
      {items.length > 0 ? <List>{items.map((it) => <ItemRow key={it.id} item={it} {...(ctx ? { ctx } : {})} />)}</List> : !unknown ? <Empty>{empty}</Empty> : null}
    </Section>
  );
}

/** Which agent Today is ABOUT: the person's own, or the workspace's organization / service. The decisions and
 *  goals of a person span their organizations; an organization's Today is that organization's alone. */
function addresseeOf(scope: WorkspaceScope, self: string | null | undefined): string | null {
  if (scope.kind === 'org') return scope.org.toLowerCase();
  if (scope.kind === 'service') return scope.agent.toLowerCase();
  return self ? self.toLowerCase() : null;
}

export function TodayView({ scope, children }: { scope: WorkspaceScope; children?: React.ReactNode }) {
  const { session, agentAddress } = useSession();
  const addressee = addresseeOf(scope, agentAddress);
  const { bundles } = useMyWork(session, agentAddress);
  const { parked, triggers, vocabulary, artifacts, records, failed, dropRun } = useTodayReads(session?.token, addressee, scope.kind === 'person' ? 'person' : 'other');

  const today: Today | null = useMemo(() => {
    if (parked === null) return null;
    // An organization's Today shows that organization's work only; a person's spans every organization.
    const mine = scope.kind === 'org' ? (bundles ?? []).filter((b) => b.org.toLowerCase().endsWith(scope.org.toLowerCase())) : scope.kind === 'service' ? [] : bundles;
    return assembleToday({ now: Date.now(), parked, bundles: mine, artifacts, triggers, vocabulary, records, recentDays: RECENT_DAYS });
  }, [parked, bundles, artifacts, triggers, vocabulary, records, scope]);

  // A canceled run leaves Today at once — the runtime dropped its checkpoint; the record says what stood.
  const ctx: CardCtx | undefined = addressee ? { token: session?.token ?? '', addressee: addressee as Address, onCanceled: dropRun } : undefined;
  const libraryHref = workspaceHref(scope, 'library');
  const playbookHref = workspaceHref(scope, 'playbook');

  if (!session) return null;
  return (
    <div className="today" data-testid="today">
      {today === null && <Meta>Reading what needs you…</Meta>}
      {today && (
        <>
          <TodaySection title="Needs your decision" items={today.decisions} empty="Nothing is waiting on you." {...(ctx ? { ctx } : {})} {...(failed.runs ? { unknown: `your unfinished asks could not be read (${failed.runs})` } : {})} />
          <TodaySection title="Active goals" items={today.active} empty="Nothing in motion. Ask for something, or take on work." {...(ctx ? { ctx } : {})} {...(failed.runs ? { unknown: `your unfinished asks could not be read (${failed.runs})` } : {})} />
          <TodaySection title="Recent artifacts" items={today.artifacts} empty={`Nothing new in the Library in the last ${RECENT_DAYS} days.`} aside={<a href={libraryHref}>Open the Library →</a>} {...(failed.artifacts ? { unknown: `the Library could not be read (${failed.artifacts})` } : {})} />
          <TodaySection title="Routine exceptions" items={today.exceptions} empty="Every routine's last firing went through." aside={<a href={playbookHref}>Playbook →</a>} {...(failed.triggers ? { unknown: `the schedule could not be read (${failed.triggers})` } : {})} />
          <Section title="Next" aside={<span data-testid="today-cost">{today.cost
            ? <>last {today.cost.days} days: {today.cost.runs} run{today.cost.runs === 1 ? '' : 's'} · {today.cost.vaultCalls} vault call{today.cost.vaultCalls === 1 ? '' : 's'} · {today.cost.doRequests} serving request{today.cost.doRequests === 1 ? '' : 's'}</>
            : failed.records ? <span style={{ color: 'var(--color-amber-700)' }}>cost unknown — the records could not be read ({failed.records})</span> : <>no run in the last {RECENT_DAYS} days carries a bill</>}</span>}>
            {today.next ? <List><ItemRow item={today.next} /></List> : <Empty>This agent offers nothing to suggest yet — <a href={playbookHref}>choose a playbook</a>.</Empty>}
          </Section>
        </>
      )}
      {children}
    </div>
  );
}
