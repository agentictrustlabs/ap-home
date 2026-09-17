'use client';
import Link from 'next/link';
// The Studio's route bodies, shared by BOTH workspace kinds (design §1.2). A card resource belongs to the
// AGENT, not to which workspace it happens to be viewed from — so the org routes and the service routes
// import the same sections and there is zero duplicated logic between them.
import type { ReactNode } from 'react';
import { A2A_CARD_EDITOR_MANIFEST } from '@agenticprimitives/home';
import { SectionShell } from '../portal/SectionShell';
import { orgHref, serviceHref, personaHref } from '../../lib/workspace';
import { CardList } from './CardList';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { type PanelId } from './Inspector';
import { AgentCardFlow } from './AgentCardFlow';
import { ListingFlow } from './ListingFlow';
import { HistoryFlow } from './HistoryFlow';
import { describeStage } from '../../lib/studio-flow';
import { studioTabs } from '../../lib/studio-listings';
import { whitelabel } from '../../whitelabel/config';
import { typedNameOf } from './parts';
import type { StudioFamily } from '../../studio-client';
import { useCanSignFor, useCardDetail, useCards, useOneShotParam, useStudioAgent, type StudioScopeKind } from './useStudio';

const INSPECTOR_PANEL_IDS = new Set<string>(A2A_CARD_EDITOR_MANIFEST.inspectorPanels);

/** `?panel=` only makes sense as an Inspector deep link when it names a real panel (design §1.3). */
function panelParam(value: string | null): PanelId | null {
  return value && INSPECTOR_PANEL_IDS.has(value) ? (value as PanelId) : null;
}

// The page is the CARD. The two projections it used to carry as tabs are their own left-nav items now
// (Naming and Registry), so repeating them here offered a second way into the same surface and made the
// card look like a hub for things it does not own (ADR-0062: a card, a projection and a publication are
// three different things).
const TITLE = 'Agent Card';

const TAB_TONE: Record<'good' | 'warn' | 'muted', string> = { good: 'var(--color-sage-700, #3f6b4a)', warn: 'var(--c-warn, #b45309)', muted: 'var(--c-g500, #6b7280)' };

/** The card and its History. Listing tabs left this strip when Naming and Registry became left-nav items.
 *  next/link, not <a>: a bare anchor here reloaded the whole app to move between two tabs of one page. */
function Tabs({ tabs, base, cardId, active }: { tabs: ReturnType<typeof studioTabs>; base: string; cardId: string; active: string }) {
  const href = `${base}/${encodeURIComponent(cardId)}`;
  return (
    <nav aria-label="Card sections" className="ui-toolbar">
      <div className="ui-tabs">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={`${href}${t.suffix}`}
            prefetch={false}
            aria-current={t.id === active ? 'page' : undefined}
            className={`ui-tab${t.id === active ? ' active' : ''}`}
            style={{ textDecoration: 'none' }}
          >
            {t.label}{t.status && <span className="ui-count" style={{ color: t.id === active ? TAB_TONE[t.tone] : undefined }}>{t.status}</span>}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function studioBasePath(kind: StudioScopeKind, agent: string): string {
  // The person's own workspace is the portal root, so their Studio is `/card` — no address in the path,
  // because there is only ever one person here and it is the one signed in.
  if (kind === 'person') return '/card';
  if (kind === 'persona') return personaHref(agent, 'card');
  return kind === 'org' ? orgHref(agent, 'card') : serviceHref(agent, 'card');
}

function Guarded({
  kind,
  agent,
  title,
  children,
}: {
  kind: StudioScopeKind;
  agent: string;
  title: string;
  children(ctx: ReturnType<typeof useStudioAgent> & { delegation: NonNullable<ReturnType<typeof useStudioAgent>['delegation']>; sa: `0x${string}` }): ReactNode;
}) {
  const ctx = useStudioAgent(kind, agent);
  if (!ctx.session) return <SectionShell title={title}><p>Not signed in.</p></SectionShell>;
  if (!ctx.loaded) return <SectionShell title={title}><p className="manage-card-blurb">Loading…</p></SectionShell>;
  if (!ctx.sa) {
    return (
      <SectionShell title={title}>
        <p className="manage-card-blurb">
          {kind === 'person'
            ? 'Your agent isn’t set up yet — finish your profile first, and your card lives here.'
            : 'You don’t manage an agent at this address.'}
        </p>
      </SectionShell>
    );
  }
  if (!ctx.delegation) {
    // A person and a managed agent fail for different reasons and deserve different sentences: the
    // person's authority is their OWN grant (spec 345), which they can retry; a managed agent's is a
    // stewardship delegation, which they either hold or do not.
    return (
      <SectionShell title={title}>
        <p className="manage-card-blurb">
          {kind === 'person'
            ? ctx.authorityError
              ? `Couldn’t set up access to your own card records: ${ctx.authorityError}`
              : 'Confirm with your device to let this page read and write your own card records.'
            : 'No stewardship delegation on this agent — the Studio talks to the agent’s own service under that delegation, so there is nothing it can read or write from here.'}
        </p>
      </SectionShell>
    );
  }
  return <>{children({ ...ctx, delegation: ctx.delegation, sa: ctx.sa })}</>;
}

// ── list ─────────────────────────────────────────────────────────────────────────────────────────

export function CardsListSection({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  return (
    <Guarded kind={kind} agent={agent} title={TITLE}>
      {(ctx) => <CardsListBody kind={kind} agent={agent} ctx={ctx} />}
    </Guarded>
  );
}

function CardsListBody({ kind, agent, ctx }: { kind: StudioScopeKind; agent: string; ctx: { delegation: NonNullable<ReturnType<typeof useStudioAgent>['delegation']>; scopes: ReturnType<typeof useStudioAgent>['scopes'] } }) {
  const { cards, projections, loaded, error, reload } = useCards(ctx.delegation);
  const router = useRouter();
  const base = studioBasePath(kind, agent);
  // ONE card is the normal case, and a list with a single row is a hop that teaches nothing: open it. The list
  // renders only where it is real — no card yet, or more than one.
  const only = loaded && !error && cards.length === 1 ? cards[0]!.resource.cardResourceId : null;
  useEffect(() => {
    if (only) router.replace(`${base}/${encodeURIComponent(only)}`);
  }, [only, router, base]);
  if (only) {
    return (
      <SectionShell title={TITLE}>
        <p className="manage-card-blurb">Opening…</p>
      </SectionShell>
    );
  }
  return (
    <SectionShell title={TITLE}>
      <CardList
        delegation={ctx.delegation}
        cards={cards}
        projections={projections}
        scopes={ctx.scopes}
        loaded={loaded}
        error={error}
        basePath={studioBasePath(kind, agent)}
        onReload={reload}
      />
    </SectionShell>
  );
}

// ── editor tabs ──────────────────────────────────────────────────────────────────────────────────

function EditorFrame({ kind, agent, cardId, tab }: { kind: StudioScopeKind; agent: string; cardId: string; tab: string }) {
  return (
    <Guarded kind={kind} agent={agent} title={TITLE}>
      {(ctx) => <EditorBody kind={kind} agent={agent} cardId={cardId} tab={tab} ctx={ctx} />}
    </Guarded>
  );
}

function EditorBody({
  kind, agent, cardId, tab, ctx,
}: {
  kind: StudioScopeKind;
  agent: string;
  cardId: string;
  tab: string;
  ctx: ReturnType<typeof useStudioAgent> & { delegation: NonNullable<ReturnType<typeof useStudioAgent>['delegation']>; sa: `0x${string}` };
}) {
  const state = useCardDetail(ctx.delegation, cardId);
  const { cards } = useCards(ctx.delegation);
  const canSign = useCanSignFor(ctx.sa);
  // Deep-link params are read once and cleared from the URL (design §1.3).
  const pointer = useOneShotParam('pointer');
  const diagnostic = useOneShotParam('diagnostic');
  const stale = useOneShotParam('stale');
  const panel = panelParam(useOneShotParam('panel'));

  const base = studioBasePath(kind, agent);
  const cardBase = `${base}/${encodeURIComponent(cardId)}`;
  const title = state.detail?.resource.displayName ?? TITLE;

  if (!state.loaded) {
    return <SectionShell title={TITLE}><p className="manage-card-blurb">Loading…</p></SectionShell>;
  }
  if (state.error || !state.detail) {
    return (
      <SectionShell title={TITLE}>
        <p className="manage-card-blurb">Couldn&rsquo;t load this card. Try again.</p>
        <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={state.reload}>Try again</button>
      </SectionShell>
    );
  }

  const detail = state.detail;
  const published = detail.releases.filter((r) => r.state === 'published').at(-1) ?? null;
  const typedName = typedNameOf(detail, ctx.name);
  const cardStatus = describeStage({ draftState: detail.draft?.state ?? null, errors: 0, checked: !!published, skillCount: detail.draft?.card.skills.length ?? 0, name: typedName });
  const tabs = studioTabs({
    brand: whitelabel.brand.name,
    agentName: typedName,
    published: published ? { releaseId: published.releaseId } : null,
    cardStatus: { status: published ? 'Saved ✓' : cardStatus.status, tone: published ? 'good' : cardStatus.tone },
    projections: state.projections,
    scopes: ctx.scopes,
    custodian: canSign,
  });

  // "All cards" only says something when there ARE others: an agent usually has one card, and a button
  // back to a one-row list reads as a place you have not been rather than a way back. `cards` here is the
  // list this editor was opened from — Agent Card in the left nav lands on it.
  const otherCards = cards.length > 1;

  return (
    <SectionShell
      title={title}
      actions={otherCards ? <Link className="btn-ghost" href={base} prefetch={false}>Other cards</Link> : undefined}
    >
      <Tabs tabs={tabs} base={base} cardId={cardId} active={tab} />
      {tab === 'card' && (
        <AgentCardFlow
          delegation={ctx.delegation}
          detail={detail}
          projections={state.projections}
          scopes={ctx.scopes}
          sa={ctx.sa}
          agentName={ctx.name}
          basePath={cardBase}
          signHashFor={ctx.signHashFor}
          onDetail={state.patch}
          onReload={state.reload}
          initialPointer={pointer}
          initialDiagnostic={diagnostic}
          initialPanel={panel}
          staleBanner={stale === '1' || detail.draft?.state === 'stale'}
        />
      )}
      {tab !== 'card' && tab !== 'history' && (
        <ListingFlow
          family={tab as StudioFamily}
          delegation={ctx.delegation}
          detail={detail}
          projections={state.projections}
          scopes={ctx.scopes}
          sa={ctx.sa}
          agentName={ctx.name}
          basePath={cardBase}
          canSign={canSign}
          signHashFor={ctx.signHashFor}
          onReload={state.reload}
        />
      )}
      {tab === 'history' && <HistoryFlow delegation={ctx.delegation} detail={detail} onReload={state.reload} />}
    </SectionShell>
  );
}

/** The old tab routes keep working as deep links: they land on the overview at the matching anchor. */
function RedirectTo({ kind, agent, cardId, suffix }: { kind: StudioScopeKind; agent: string; cardId: string; suffix: string }) {
  const router = useRouter();
  useEffect(() => {
    const q = typeof window !== 'undefined' ? window.location.search : '';
    router.replace(`${studioBasePath(kind, agent)}/${encodeURIComponent(cardId)}${suffix}${q}`);
  }, [router, kind, agent, cardId, suffix]);
  return <SectionShell title={TITLE}><p className="manage-card-blurb">Opening…</p></SectionShell>;
}

export function AgentCardEditorSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="card" />;
}
export function ListingSection(p: { kind: StudioScopeKind; agent: string; cardId: string; family: string }) {
  return <EditorFrame kind={p.kind} agent={p.agent} cardId={p.cardId} tab={p.family} />;
}
export function HistorySection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="history" />;
}
/** Pre-split URLs keep working: Projections and Names & Bindings both meant "where is this agent listed". */
export function ProjectionCenterSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectTo {...p} suffix="/listing/ap-naming" />;
}
export function NamesBindingsSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectTo {...p} suffix="/listing/ap-naming" />;
}
export function ReleasesAuditSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectTo {...p} suffix="/history" />;
}
