'use client';
import { use } from 'react';
import { HistorySection } from '../../../../../src/components/studio/CardStudio';

export default function PersonHistoryPage({ params }: { params: Promise<{ cardResourceId: string }> }) {
  const { cardResourceId } = use(params);
  return <HistorySection kind="person" agent="" cardId={cardResourceId} />;
}
