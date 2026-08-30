'use client';
import { use } from 'react';
import { ProjectionCenterSection } from '../../../../../../../src/components/studio/CardStudio';

export default function ProjectionsPage({ params }: { params: Promise<{ org: string; cardResourceId: string }> }) {
  const { org, cardResourceId } = use(params);
  return <ProjectionCenterSection kind="org" agent={org} cardId={cardResourceId} />;
}
