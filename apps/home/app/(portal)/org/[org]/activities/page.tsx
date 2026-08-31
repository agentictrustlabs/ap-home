'use client';
import { use } from 'react';
import { ActivityTimeline } from '../../../../../src/components/portal/ActivityTimeline';

export default function OrgActivitiesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = use(params);
  return <ActivityTimeline agent={org} />;
}
