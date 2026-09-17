'use client';
import { use } from 'react';
import { CardsListSection } from '../../../../../src/components/studio/CardStudio';

export default function CardsListPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <CardsListSection kind="persona" agent={agent} />;
}
