'use client';
import { use } from 'react';
import { ListingSection } from '../../../../../../src/components/studio/CardStudio';

export default function PersonListingPage({ params }: { params: Promise<{ cardResourceId: string; family: string }> }) {
  const p = use(params);
  return <ListingSection kind="person" agent="" cardId={p.cardResourceId} family={p.family} />;
}
