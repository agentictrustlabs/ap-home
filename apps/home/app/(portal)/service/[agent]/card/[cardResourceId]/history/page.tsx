'use client';
import { use } from 'react';
import { HistorySection } from '../../../../../../../src/components/studio/CardStudio';

export default function HistoryPage({ params }: { params: Promise<{ agent: string; cardResourceId: string }> }) {
  const p = use(params);
  return <HistorySection kind="service" agent={p.agent} cardId={p.cardResourceId} />;
}
