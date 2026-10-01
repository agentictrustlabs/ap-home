'use client';
// Settings → Identity & presence → Registry — THIS agent's entry in the directory, and the one action
// that puts it there.
//
// It used to be a roster: every named agent in the knowledge base, 37 rows deep, each with its own
// Register button, inside the settings of one agent. That is an operator's tool, and browsing every agent
// is what the Discovery app is for. A settings page answers one question about one agent.
//
// The action is the same shape as Naming's: the agent's card, projected to a target and published
// (spec 347 §6). A registry entry names a CARD — that is what a directory serves when someone finds this
// agent — so listing without a card is not a thing you can do, and the flow says so rather than offering
// a button that cannot work.
import { useMemo } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useCanSignFor, useCardDetail, useCards, useStudioAgent, type StudioScopeKind } from '../../studio/useStudio';
import { studioBasePath } from '../../studio/CardStudio';
import { ListingFlow } from '../../studio/ListingFlow';
import { SectionShell } from '../SectionShell';
import { mutedText } from '../theme';

import { Loading } from '../../shared/Loading';
export function AgentRegistryListing({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  const ctx = useStudioAgent(kind, agent);
  const { cards, loaded: cardsLoaded } = useCards(ctx.delegation);
  const primary = useMemo(
    () => cards.find((c) => c.resource.primary && c.resource.environment === 'production') ?? cards[0] ?? null,
    [cards],
  );
  const cardId = primary?.resource.cardResourceId ?? '';
  const state = useCardDetail(ctx.delegation, cardId);
  const canSign = useCanSignFor(ctx.sa);

  if (!ctx.session) return <SectionShell title="Registry"><p className="ui-meta">Not signed in.</p></SectionShell>;
  if (!ctx.loaded || !cardsLoaded) return <SectionShell title="Registry"><Loading /></SectionShell>;
  if (!ctx.delegation || !ctx.sa) {
    return (
      <SectionShell title="Registry">
        <p className="manage-card-blurb">This agent&rsquo;s service can&rsquo;t be reached from here.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Registry" description="Listing this agent where people and other agents search — the listing points at its agent card, so whoever finds it reads what the card says.">
      {/* Two prerequisites, said BEFORE the button rather than discovered by pressing it. The type is not
          inferred from the name here on purpose: spec 346 makes the on-chain `atl:agentType` the
          authority and a suffix only a claim, so guessing from ".impact" would be the very inference the
          spec refuses. Stating the requirement is honest; asserting this agent fails it would not be. */}
      <p className="ui-note">
        A directory needs two things from an agent: a <b>card</b> to point at, and a declared <b>type</b> —
        what kind of agent it is — which it gets from a typed name (<code>.me</code>, <code>.org</code>,
        <code>.team</code>, <code>.church</code>, <code>.circle</code>, <code>.svc</code>,
        <code>.workspace</code>, <code>.treasury</code>, <code>.registry</code>). A legacy{' '}
        <code>.impact</code> or <code>.agent</code> name carries no type.
      </p>
      {!primary ? (
        <p style={{ ...mutedText, fontSize: '.85rem' }}>
          No agent card yet. A directory entry names a card — make one under <b>Agent Card</b> first, and
          listing becomes available here.
        </p>
      ) : !state.loaded ? (
        <Loading compact label="Loading the card…" />
      ) : !state.detail ? (
        <p style={{ ...mutedText, fontSize: '.85rem' }}>Couldn&rsquo;t read the card just now.</p>
      ) : (
        <ListingFlow
          family="ap-registry"
          delegation={ctx.delegation}
          detail={state.detail}
          projections={state.projections}
          scopes={ctx.scopes}
          sa={ctx.sa as Address}
          agentName={ctx.name}
          basePath={`${studioBasePath(kind, agent)}/${encodeURIComponent(cardId)}`}
          canSign={canSign}
          signHashFor={ctx.signHashFor}
          onReload={state.reload}
        />
      )}
    </SectionShell>
  );
}
