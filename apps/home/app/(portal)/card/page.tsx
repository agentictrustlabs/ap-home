'use client';
// The PERSON's own Agent Card & Projection Studio (spec 347 §9). Same Studio as an org's or a service's
// — a card belongs to the AGENT, and a person is one (ADR-0046). No address in the path: there is exactly
// one person in this workspace, the one signed in.
import { CardsListSection } from '../../../src/components/studio/CardStudio';

export default function PersonCardsListPage() {
  return <CardsListSection kind="person" agent="" />;
}
