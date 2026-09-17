'use client';
import { use } from 'react';
import { ServicePlaybookSection } from '../../../../../src/components/portal/ServiceWorkspace';

export default function PersonaPlaybookPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServicePlaybookSection agent={agent} />;
}
