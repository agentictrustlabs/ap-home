'use client';
import { use } from 'react';
import { ProjectionCenterSection } from '../../../../../../../src/components/studio/CardStudio';

export default function ProjectionsPage({ params }: { params: Promise<{ agent: string; cardResourceId: string }> }) {
  const { agent, cardResourceId } = use(params);
  return <ProjectionCenterSection kind="service" agent={agent} cardId={cardResourceId} />;
}
