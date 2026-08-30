'use client';
import { use } from 'react';
import { HistorySection } from '../../../../../../../src/components/studio/CardStudio';

export default function HistoryPage({ params }: { params: Promise<{ org: string; cardResourceId: string }> }) {
  const p = use(params);
  return <HistorySection kind="org" agent={p.org} cardId={p.cardResourceId} />;
}
