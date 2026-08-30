'use client';
import { use } from 'react';
import { ListingSection } from '../../../../../../../../src/components/studio/CardStudio';

export default function ListingPage({ params }: { params: Promise<{ org: string; cardResourceId: string; family: string }> }) {
  const p = use(params);
  return <ListingSection kind="org" agent={p.org} cardId={p.cardResourceId} family={p.family} />;
}
