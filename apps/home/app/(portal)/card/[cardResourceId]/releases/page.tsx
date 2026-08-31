'use client';
import { use } from 'react';
import { ReleasesAuditSection } from '../../../../../src/components/studio/CardStudio';

export default function PersonReleasesPage({ params }: { params: Promise<{ cardResourceId: string }> }) {
  const { cardResourceId } = use(params);
  return <ReleasesAuditSection kind="person" agent="" cardId={cardResourceId} />;
}
