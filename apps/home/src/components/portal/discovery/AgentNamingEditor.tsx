'use client';
// Settings → Identity & presence → Naming (spec 348 §2.3) — the name, everything published under it, and
// the card projection that writes to it, in one place.
//
// Before this, one fact had three homes: the A2A endpoint was set inside the card editor (because the
// card needs it), the name records that carry it were edited on a `Metadata` page, and the projection
// that publishes the card to the name lived in the Studio under `Card & Projections`. Three screens, one
// question — "what does this name say, and where does it point?"
//
// The rule that collapses them: a name record is published under the name, so it is edited with the name.
// The projection writes name records, so it is run from the same page. What stays in the Studio is the
// CARD — a card is a document about the agent; a projection is what one target is told about it
// (ADR-0062), and they are not the same thing.
import { useMemo } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useCardDetail, useCards, useCanSignFor, useStudioAgent, type StudioScopeKind } from '../../studio/useStudio';
import { studioBasePath } from '../../studio/CardStudio';
import { ListingFlow } from '../../studio/ListingFlow';
import { PublishedMetadataPanels } from './AgentMetadataTiers';
import { mutedText } from '../theme';

/**
 * The card projection that writes this agent's name records, for the agent's PRIMARY card.
 *
 * Naming asks about one name, so it shows one card's projection — the primary. A managed agent with
 * several cards (staging, a second environment) still reaches the others through the Studio; putting a
 * card picker here would make Naming a card surface, which is the collapse this page exists to undo.
 */
function NamingProjection({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  const ctx = useStudioAgent(kind, agent);
  const { cards, loaded: cardsLoaded } = useCards(ctx.delegation);
  const primary = useMemo(
    () => cards.find((c) => c.resource.primary && c.resource.environment === 'production') ?? cards[0] ?? null,
    [cards],
  );
  const cardId = primary?.resource.cardResourceId ?? '';
  const state = useCardDetail(ctx.delegation, cardId);
  const canSign = useCanSignFor(ctx.sa);

  if (!ctx.delegation || !ctx.sa) return null;
  if (!cardsLoaded) return <p style={{ ...mutedText, fontSize: '.82rem' }}>Checking what your card publishes here…</p>;
  if (!primary) {
    return (
      <p style={{ ...mutedText, fontSize: '.82rem' }}>
        No agent card yet, so nothing is published to this name from one. A card describes what this agent
        is and how to reach it; making one is the first step in <b>Agent Card</b>.
      </p>
    );
  }
  if (!state.loaded) return <p style={{ ...mutedText, fontSize: '.82rem' }}>Loading the card…</p>;
  if (!state.detail) return <p style={{ ...mutedText, fontSize: '.82rem' }}>Couldn&rsquo;t read the card just now.</p>;

  return (
    <ListingFlow
      family="ap-naming"
      delegation={ctx.delegation}
      detail={state.detail}
      projections={state.projections}
      scopes={ctx.scopes}
      sa={ctx.sa}
      agentName={ctx.name}
      basePath={`${studioBasePath(kind, agent)}/${encodeURIComponent(cardId)}`}
      canSign={canSign}
      signHashFor={ctx.signHashFor}
      onReload={state.reload}
    />
  );
}

/** The published half of Naming: the records under the name, the projection that writes them, and the
 *  read-only account profile. Each class renders its own "the name itself" section above this. */
export function AgentNamingEditor({ kind, agent }: { kind: StudioScopeKind; agent: string }) {
  const ctx = useStudioAgent(kind, agent);
  const cls = kind === 'org' ? 'org' : kind === 'service' ? 'service' : 'person';
  if (!ctx.sa) return null;
  return (
    <>
      <div style={{ marginTop: '1.5rem' }}>
        <h3 className="subhead">What your card publishes here</h3>
        <p className="manage-card-blurb" style={{ margin: '0 0 .8rem' }}>
          Pointing your name at your agent card, so anyone who looks the name up finds the card.
        </p>
        <NamingProjection kind={kind} agent={agent} />
      </div>
      <div style={{ marginTop: '1.5rem' }}>
        <PublishedMetadataPanels agent={ctx.sa as Address} name={ctx.name || null} cls={cls} />
      </div>
    </>
  );
}
