'use client';
import { use } from 'react';
import { ProjectionCenterSection } from '../../../../../src/components/studio/CardStudio';

export default function PersonProjectionsPage({ params }: { params: Promise<{ cardResourceId: string }> }) {
  const { cardResourceId } = use(params);
  return <ProjectionCenterSection kind="person" agent="" cardId={cardResourceId} />;
}
