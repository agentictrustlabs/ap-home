'use client';
import { use } from 'react';
import { ReleasesAuditSection } from '../../../../../../../src/components/studio/CardStudio';

export default function ReleasesPage({ params }: { params: Promise<{ org: string; cardResourceId: string }> }) {
  const { org, cardResourceId } = use(params);
  return <ReleasesAuditSection kind="org" agent={org} cardId={cardResourceId} />;
}
