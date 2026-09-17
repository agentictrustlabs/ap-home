'use client';
import { use } from 'react';
import { ServiceAccessSection } from '../../../../../src/components/portal/ServiceWorkspace';

export default function PersonaAccessPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = use(params);
  return <ServiceAccessSection agent={agent} />;
}
