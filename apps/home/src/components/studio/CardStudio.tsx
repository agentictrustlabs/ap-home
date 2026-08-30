'use client';
// The Studio's route bodies, shared by BOTH workspace kinds (design §1.2). A card resource belongs to the
// AGENT, not to which workspace it happens to be viewed from — so the org routes and the service routes
// import the same sections and there is zero duplicated logic between them.
import type { ReactNode } from 'react';
import { VERSION_LABELS } from '@agenticprimitives/home';
import { SectionShell } from '../portal/SectionShell';
import { orgHref, serviceHref } from '../../lib/workspace';
import { CardList } from './CardList';
import { CardEditor } from './CardEditor';
import { ProjectionCenter } from './ProjectionCenter';
import { NamesAndBindings } from './NamesAndBindings';
import { ReleasesAndAudit } from './ReleasesAndAudit';
import { useCardDetail, useCards, useOneShotParam, useStudioAgent, type StudioScopeKind } from './useStudio';

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

function Tabs({ base, cardId, active }: { base: string; cardId: string; active: 'card' | 'projections' | 'names' | 'releases' }) {
  const href = `${base}/${encodeURIComponent(cardId)}`;
  const tabs: Array<{ id: typeof active; label: string; href: string }> = [
    { id: 'card', label: 'Agent Card', href },
    { id: 'projections', label: 'Projections', href: `${href}/projections` },
    { id: 'names', label: 'Names & Bindings', href: `${href}/names` },
    { id: 'releases', label: 'Releases & Audit', href: `${href}/releases` },
  ];
  return (
    <nav aria-label="Card studio tabs" style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', margin: '0 0 .8rem' }}>
      {tabs.map((t) => (
        <a
          key={t.id}
          href={t.href}
          aria-current={t.id === active ? 'page' : undefined}
          style={{
            fontSize: '.78rem',
            fontWeight: t.id === active ? 700 : 500,
            padding: '.4rem .7rem',
            minHeight: 36,
            borderRadius: 8,
            textDecoration: 'none',
            border: '1px solid var(--c-g200)',
            background: t.id === active ? 'var(--c-primary-subtle)' : 'var(--color-surface)',
            color: t.id === active ? 'var(--c-primary)' : 'var(--c-g700)',
          }}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
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
        The A2A card is what other agents see when they look this one up. Author it here, release it through an
        approval chain, then project it into AP Naming and the AP Registry — with every loss and every drift
        visible.
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

type TabId = 'card' | 'projections' | 'names' | 'releases';

function EditorFrame({
  kind,
  agent,
  cardId,
  tab,
}: {
  kind: StudioScopeKind;
  agent: string;
  cardId: string;
  tab: TabId;
}) {
  return (
    <Guarded kind={kind} agent={agent} title={TITLE}>
      {(ctx) => <EditorBody kind={kind} agent={agent} cardId={cardId} tab={tab} ctx={ctx} />}
    </Guarded>
  );
}

function EditorBody({
  kind,
  agent,
  cardId,
  tab,
  ctx,
}: {
  kind: StudioScopeKind;
  agent: string;
  cardId: string;
  tab: TabId;
  ctx: ReturnType<typeof useStudioAgent> & { delegation: NonNullable<ReturnType<typeof useStudioAgent>['delegation']>; sa: `0x${string}` };
}) {
  const state = useCardDetail(ctx.delegation, cardId);
  // Deep-link params are read once and cleared from the URL (design §1.3).
  const pointer = useOneShotParam('pointer');
  const diagnostic = useOneShotParam('diagnostic');
  const stale = useOneShotParam('stale');
  const focusRelease = useOneShotParam('release');
  const focusInstance = useOneShotParam('instance');

  const base = studioBasePath(kind, agent);
  const title = state.detail?.resource.displayName ?? TITLE;

  if (!state.loaded) {
    return (
      <SectionShell title={TITLE}>
        <Tabs base={base} cardId={cardId} active={tab} />
        <p className="manage-card-blurb">Loading…</p>
      </SectionShell>
    );
  }
  if (state.error || !state.detail) {
    return (
      <SectionShell title={TITLE}>
        <Tabs base={base} cardId={cardId} active={tab} />
        <p className="manage-card-blurb">Couldn&rsquo;t load this card. Try again.</p>
        <button type="button" className="btn-ghost" style={{ marginTop: '.5rem' }} onClick={state.reload}>
          Try again
        </button>
      </SectionShell>
    );
  }

  const detail = state.detail;
  const latest = detail.releases[detail.releases.length - 1];

  return (
    <SectionShell
      title={title}
      actions={
        <a className="btn-ghost" href={base}>
          All cards
        </a>
      }
    >
      <Tabs base={base} cardId={cardId} active={tab} />
      <p className="manage-card-blurb" style={{ margin: '0 0 .7rem' }}>
        {detail.resource.environment} · {detail.resource.primary ? 'primary' : 'secondary'} ·{' '}
        {latest ? `${VERSION_LABELS.cardRelease} ${latest.releaseNumber} (${latest.state})` : `no ${VERSION_LABELS.cardRelease.toLowerCase()} yet`}
      </p>
      {tab === 'card' && (
        <CardEditor
          delegation={ctx.delegation}
          detail={detail}
          projections={state.projections}
          scopes={ctx.scopes}
          onDetail={state.patch}
          onReload={state.reload}
          initialPointer={pointer}
          initialDiagnostic={diagnostic}
          staleBanner={stale === '1' || detail.draft?.state === 'stale'}
          releasesHref={`${base}/${cardId}/releases`}
        />
      )}
      {tab === 'projections' && (
        <ProjectionCenter
          delegation={ctx.delegation}
          detail={detail}
          projections={state.projections}
          bindings={state.bindings}
          scopes={ctx.scopes}
          sa={ctx.sa}
          signHashFor={ctx.signHashFor}
          onReload={state.reload}
          focusInstance={focusInstance}
        />
      )}
      {tab === 'names' && (
        <NamesAndBindings
          delegation={ctx.delegation}
          detail={detail}
          projections={state.projections}
          bindings={state.bindings}
          scopes={ctx.scopes}
          sa={ctx.sa}
          agentName={ctx.name}
        />
      )}
      {tab === 'releases' && (
        <ReleasesAndAudit
          delegation={ctx.delegation}
          detail={detail}
          scopes={ctx.scopes}
          sa={ctx.sa}
          agentName={ctx.name}
          signHashFor={ctx.signHashFor}
          onReload={state.reload}
          focusRelease={focusRelease}
        />
      )}
    </SectionShell>
  );
}

export function AgentCardEditorSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="card" />;
}
export function ProjectionCenterSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="projections" />;
}
export function NamesBindingsSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="names" />;
}
export function ReleasesAuditSection(p: { kind: StudioScopeKind; agent: string; cardId: string }) {
  return <EditorFrame {...p} tab="releases" />;
}
