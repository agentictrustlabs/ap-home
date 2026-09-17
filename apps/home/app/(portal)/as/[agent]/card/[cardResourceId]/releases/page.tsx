'use client';
import { use } from 'react';
import { ReleasesAuditSection } from '../../../../../../../src/components/studio/CardStudio';

export default function ReleasesPage({ params }: { params: Promise<{ agent: string; cardResourceId: string }> }) {
  const { agent, cardResourceId } = use(params);
  return <ReleasesAuditSection kind="persona" agent={agent} cardId={cardResourceId} />;
}
