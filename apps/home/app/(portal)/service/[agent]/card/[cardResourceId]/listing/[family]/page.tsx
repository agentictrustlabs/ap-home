'use client';
import { use } from 'react';
import { ListingSection } from '../../../../../../../../src/components/studio/CardStudio';

export default function ListingPage({ params }: { params: Promise<{ agent: string; cardResourceId: string; family: string }> }) {
  const p = use(params);
  return <ListingSection kind="service" agent={p.agent} cardId={p.cardResourceId} family={p.family} />;
}
