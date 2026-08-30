'use client';
// The Studio's route bodies, shared by BOTH workspace kinds (design §1.2). A card resource belongs to the
// AGENT, not to which workspace it happens to be viewed from — so the org routes and the service routes
// import the same sections and there is zero duplicated logic between them.
import type { ReactNode } from 'react';
import { A2A_CARD_EDITOR_MANIFEST } from '@agenticprimitives/home';
import { SectionShell } from '../portal/SectionShell';
import { orgHref, serviceHref } from '../../lib/workspace';
import { CardList } from './CardList';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { type PanelId } from './Inspector';
import { Overview } from './Overview';
import { useCardDetail, useCards, useOneShotParam, useStudioAgent, type StudioScopeKind } from './useStudio';

const INSPECTOR_PANEL_IDS = new Set<string>(A2A_CARD_EDITOR_MANIFEST.inspectorPanels);

/** `?panel=` only makes sense as an Inspector deep link when it names a real panel (design §1.3). */
function panelParam(value: string | null): PanelId | null {
  return value && INSPECTOR_PANEL_IDS.has(value) ? (value as PanelId) : null;
}

const TITLE = 'Card & Projections';

export function studioBasePath(kind: StudioScopeKind, agent: string): string {
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
        <p className="manage-card-blurb">You don&rsquo;t manage an agent at this address.</p>
      </SectionShell>
    );
  }
  if (!ctx.delegation) {
    return (
      <SectionShell title={title}>
        <p className="manage-card-blurb">
          No stewardship delegation on this agent — the Studio talks to the agent&rsquo;s own service under that
          delegation, so there is nothing it can read or write from here.
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
  return (
    <SectionShell title={TITLE}>
      <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
        A card is what other agents see when they look this one up — what it does and how to reach it. Describe it,
        make it live at its public address, then list it where agents and people search.
      </p>
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

function EditorFrame({ kind, agent, cardId }: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return (
    <Guarded kind={kind} agent={agent} title={TITLE}>
      {(ctx) => <EditorBody kind={kind} agent={agent} cardId={cardId} ctx={ctx} />}
    </Guarded>
  );
}

function EditorBody({
  kind,
  agent,
  cardId,
  ctx,
}: {
  kind: StudioScopeKind;
  agent: string;
  cardId: string;
  ctx: ReturnType<typeof useStudioAgent> & { delegation: NonNullable<ReturnType<typeof useStudioAgent>['delegation']>; sa: `0x${string}` };
}) {
  const state = useCardDetail(ctx.delegation, cardId);
  // Deep-link params are read once and cleared from the URL (design §1.3).
  const pointer = useOneShotParam('pointer');
  const diagnostic = useOneShotParam('diagnostic');
  const stale = useOneShotParam('stale');
  const panel = panelParam(useOneShotParam('panel'));

  const base = studioBasePath(kind, agent);
  const title = state.detail?.resource.displayName ?? TITLE;

  if (!state.loaded) {
    return (
      <SectionShell title={TITLE}>
        <p className="manage-card-blurb">Loading…</p>
      </SectionShell>
    );
  }
  if (state.error || !state.detail) {
    return (
      <SectionShell title={TITLE}>
        <p className="manage-card-blurb">Couldn&rsquo;t load this card. Try again.</p>
        <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={state.reload}>
          Try again
        </button>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title={title}
      actions={
        <a className="btn-ghost" href={base}>
          All cards
        </a>
      }
    >
      <Overview
        delegation={ctx.delegation}
        detail={state.detail}
        projections={state.projections}
        scopes={ctx.scopes}
        sa={ctx.sa}
        agentName={ctx.name}
        signHashFor={ctx.signHashFor}
        onDetail={state.patch}
        onReload={state.reload}
        initialPointer={pointer}
        initialDiagnostic={diagnostic}
        initialPanel={panel}
        staleBanner={stale === '1' || state.detail.draft?.state === 'stale'}
      />
    </SectionShell>
  );
}

/** The old tab routes keep working as deep links: they land on the overview at the matching anchor. */
function RedirectToOverview({ kind, agent, cardId, hash }: { kind: StudioScopeKind; agent: string; cardId: string; hash: string }) {
  const router = useRouter();
  useEffect(() => {
    const q = typeof window !== 'undefined' ? window.location.search : '';
    router.replace(`${studioBasePath(kind, agent)}/${encodeURIComponent(cardId)}${q}${hash}`);
  }, [router, kind, agent, cardId, hash]);
  return <SectionShell title={TITLE}><p className="manage-card-blurb">Opening…</p></SectionShell>;
}

export function AgentCardEditorSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} />;
}
export function ProjectionCenterSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectToOverview {...p} hash="#list" />;
}
export function NamesBindingsSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectToOverview {...p} hash="#list" />;
}
export function ReleasesAuditSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <RedirectToOverview {...p} hash="#history" />;
}
