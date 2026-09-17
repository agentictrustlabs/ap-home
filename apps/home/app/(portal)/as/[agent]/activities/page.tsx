'use client';
import { use } from 'react';
import { ActivityTimeline } from '../../../../../src/components/portal/ActivityTimeline';

export default function PersonaActivitiesPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ActivityTimeline agent={agent} />;
}
