'use client';
import { use } from 'react';
import { ServiceRecordsSection } from '../../../../../src/components/portal/ServiceWorkspace';

export default function ServiceRecordsPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceRecordsSection agent={agent} />;
}
