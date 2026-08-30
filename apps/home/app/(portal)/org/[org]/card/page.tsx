'use client';
import { use } from 'react';
import { CardsListSection } from '../../../../../src/components/studio/CardStudio';

export default function CardsListPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <CardsListSection kind="org" agent={org} />;
}
